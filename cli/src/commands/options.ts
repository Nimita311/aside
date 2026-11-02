import { Argument, Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { isAbsolute } from 'node:path';
import { VERSION } from '../version.js';
import { isCalendarDate } from '../core/scheduling.js';

// One command tree owns parsing, validation, and help for both the public CLI
// and command functions called directly by tests or other source modules.
export interface ParsedCommand {
  command: string;
  operation?: string;
  helpText?: string;
  displayText?: string;
  has(name: string): boolean;
  get(name: string): string | undefined;
  all(name: string): string[] | undefined;
  fail(message: string): never;
}
export type CommandInput = string[] | ParsedCommand;

export class CliParseError extends Error {
  constructor(message: string, readonly jsonRequested: boolean) {
    super(message);
    this.name = 'CliParseError';
  }
}

interface ValueRules {
  required?: boolean;
  repeatable?: boolean;
  allowEmpty?: boolean;
  trim?: boolean;
  choices?: string[];
  conflicts?: string;
  parse?: (value: string) => string;
}

function value(command: Command, flags: string, description: string, rules: ValueRules = {}): void {
  const option = new Option(flags, description + (rules.required ? ' (required)' : '')).makeOptionMandatory(!!rules.required);
  if (rules.conflicts) option.conflicts(rules.conflicts);
  const choices = rules.choices;
  if (choices) option.choices(choices);
  option.argParser((raw: string, previous?: string | string[]) => {
    if (previous !== undefined && !rules.repeatable) throw new InvalidArgumentError(`duplicate option ${option.long}`);
    const text = rules.trim ? raw.trim() : raw;
    if (!text && !rules.allowEmpty) throw new InvalidArgumentError(`${option.long} requires a nonempty value`);
    if (choices && !choices.includes(text)) throw new InvalidArgumentError(`must be ${choices.join(', ')}`);
    const parsed = rules.parse ? rules.parse(text) : text;
    return rules.repeatable ? [...((previous as string[] | undefined) ?? []), parsed] : parsed;
  });
  command.addOption(option);
}

function flag(command: Command, flags: string, description: string): void {
  const option = new Option(flags, description);
  command.addOption(option);
  let seen = false;
  command.on(`option:${option.name()}`, () => {
    if (seen) command.error(`duplicate option ${option.long}`, { code: 'aside.duplicateOption' });
    seen = true;
  });
}

function json(command: Command): void { flag(command, '--json', 'Return structured JSON output'); }
function directory(command: Command, rules: ValueRules = {}): void {
  value(command, '--dir <path>', rules.repeatable ? 'Instance directory (repeatable)' : 'Instance directory (default: current directory)', rules);
}
function date(value: string): string {
  if (!isCalendarDate(value)) throw new InvalidArgumentError('must be a date in YYYY-MM-DD format');
  return value;
}
function integer(value: string, limit = false): string {
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || (limit ? number < 1 || number > 100 : number < 0)) {
    throw new InvalidArgumentError(limit ? 'must be an integer from 1 to 100' : 'must be a nonnegative integer');
  }
  return value;
}

function createProgram(): Command {
  const program = new Command('aside')
    .description('CLI for the Aside productivity framework')
    .version(VERSION, '-V, --version', 'Show the CLI version')
    .enablePositionalOptions()
    .configureHelp({ helpWidth: 100 })
    .addHelpCommand(false);
  program.addHelpText('after', `\nExamples:\n  aside instance init --dir ~/my-aside --name Work --description "Work log" --tutorial\n  aside show '#action/2026-10-05-review' --dir ~/my-aside\n  aside daemon start\n  aside plugin install --agent codex\n\nRun aside <command> --help for command options. Human commands support --json.`);

  const show = program.command('show').description('Open an object or the instance selector in the browser');
  show.addArgument(new Argument('[target]', 'Aside URL or quoted #type/id handle').argParser(raw => {
    if (!raw) throw new InvalidArgumentError('target must not be empty');
    return raw;
  }));
  value(show, '--dir <path>', 'Instance directory; requires a target or --url');
  flag(show, '--url', 'Print the web URL and exit without opening or navigating a browser');
  value(show, '--app-dir <path>', 'Webapp build directory'); json(show);
  show.addHelpText('after', `\nNo target opens the instance selector. Handles use the workspace selection or sole known instance.\nURLs select by instance ID. Quote handles beginning with '#'.\nWith --url, prints only the URL; --dir without a target selects an instance's timeline.\n\nExamples:\n  aside show\n  aside show --url\n  aside show --url --dir ~/aside/work\n  aside show '#action/2026-10-05-review' --dir ~/aside/work\n  aside show 'aside://work/action/2026-10-05-review'`);

  const mcp = program.command('mcp').description('Start the GraphQL MCP server (discovers instances by default)');
  value(mcp, '--dir <path>', 'Select one instance instead of discovering instances');
  flag(mcp, '--legacy', 'Use the legacy entity and utility tools instead of GraphQL');

  const graphql = program.command('graphql').description('Execute GraphQL documents through the shared daemon');
  for (const operation of ['query', 'mutate']) {
    const cmd = graphql.command(operation).description(`Execute a GraphQL ${operation === 'query' ? 'query' : 'mutation'} document`);
    value(cmd, '--dir <path>', 'Select an instance; otherwise use MCP workspace discovery');
    value(cmd, '--document <graphql>', 'GraphQL source text', { conflicts: 'documentFile' });
    value(cmd, '--document-file <path>', 'Read a UTF-8 GraphQL document; use - for stdin', { conflicts: 'document' });
    value(cmd, '--variables <json>', 'GraphQL variable values as a JSON object', { conflicts: 'variablesFile' });
    value(cmd, '--variables-file <path>', 'Read GraphQL variable values from a JSON file', { conflicts: 'variables' });
    value(cmd, '--operation-name <name>', 'Select a named operation from the document');
    flag(cmd, '--json', 'Return standard GraphQL JSON (the default)');
    cmd.hook('preAction', command => {
      const opts = command.opts();
      if (opts.document === undefined && opts.documentFile === undefined) command.error('provide --document or --document-file', { code: 'aside.graphqlDocument' });
    });
    cmd.addHelpText('after', `\nReturns standard GraphQL JSON with data, errors, and extensions. Errors exit with status 1;\npartial data and mutation receipts remain in the response. Selection lasts for this invocation.\nQueries are read-only. Mutations can partially succeed and must not be automatically retried.\n\nExamples:\n  aside graphql query --document '{ activeInstance { id name } }'\n  aside graphql ${operation} --document-file request.graphql --variables-file variables.json\n  cat request.graphql | aside graphql ${operation} --document-file -`);
  }

  const usage = program.command('usage').description('Inspect local per-instance GraphQL usage');
  const usageSummary = usage.command('summary').description('Summarize retained GraphQL reads and mutations without starting the daemon');
  directory(usageSummary); json(usageSummary);
  value(usageSummary, '--since <days>', 'Look back this many days (default: 7d)', {parse: value => {
    if (!/^[1-9]\d*d$/.test(value) || Number(value.slice(0, -1)) > 36500) throw new InvalidArgumentError('must be a positive day duration such as 7d (max 36500d)');
    return value;
  }});

  const diagnostics = program.command('diagnostics').description('Manage retained local diagnostic history');
  const purge = diagnostics.command('purge').description('Delete usage logs and completed automation history without starting the daemon');
  value(purge, '--dir <path>', 'Instance directory, including a previous or deleted location');
  flag(purge, '--all', 'Purge completed diagnostic history for all instances'); json(purge);
  purge.hook('preAction', command => {
    const opts = command.opts();
    if ((opts.dir !== undefined) === (opts.all === true)) command.error('provide exactly one of --dir or --all', {code: 'aside.diagnosticScope'});
  });
  purge.addHelpText('after', '\nPurges daemon-managed GraphQL usage logs and completed automation runs.\nActive runs, scheduling claims, and instance records are preserved.');

  const artifact = program.command('artifact').description('Create, update, or query durable content');
  artifact.addHelpText('after', '\nExamples:\n  aside artifact create --name Plan --description "Current plan" --body-file plan.md\n  aside artifact update --id 2026-10-05-plan --body-file plan.md\n  aside artifact query --detail full');
  for (const operation of ['create', 'update']) {
    const cmd = artifact.command(operation).description(operation === 'create' ? 'Create an artifact and import supporting files' : 'Update an artifact by its stable ID');
    directory(cmd); json(cmd);
    if (operation === 'update') value(cmd, '--id <id>', 'Artifact ID to update', { required: true, trim: true });
    value(cmd, '--name <name>', 'Display name', { required: operation === 'create', trim: operation === 'create', allowEmpty: operation === 'update' });
    value(cmd, '--description <text>', 'One-line index description', { required: operation === 'create', trim: operation === 'create', allowEmpty: operation === 'update' });
    value(cmd, '--body <text>', 'Markdown body; an empty string clears it', { allowEmpty: true, conflicts: 'bodyFile' });
    value(cmd, '--body-file <path>', 'Read the Markdown body from a file', { conflicts: 'body' });
    value(cmd, '--file <source>', 'Import path or filename=path (repeatable)', { repeatable: true });
    if (operation === 'update') value(cmd, '--remove-file <filename>', 'Remove an attachment by exact filename (repeatable)', { repeatable: true });
    cmd.addHelpText('after', '\nAn empty body with one attachment displays that file.\nUse --body=-draft' + (operation === 'update' ? ' or --remove-file=-filename' : '') + ' for values beginning with a dash.');
  }
  const query = artifact.command('query').description('Find artifacts with filters and pagination');
  directory(query); json(query);
  value(query, '--id <id>', 'Exact artifact ID (repeatable)', { repeatable: true });
  value(query, '--project <id>', 'Referencing project (repeatable)', { repeatable: true });
  value(query, '--action <id>', 'Referencing action (repeatable)', { repeatable: true });
  value(query, '--from <YYYY-MM-DD>', 'Created date start (inclusive)', { parse: date });
  value(query, '--to <YYYY-MM-DD>', 'Created date end (inclusive)', { parse: date });
  value(query, '--search <regex>', 'Case-insensitive text search', { allowEmpty: true });
  value(query, '--detail <level>', 'Result detail (default: index)', { choices: ['index', 'metadata', 'full'] });
  value(query, '--offset <number>', 'Starting result (default: 0)', { parse: integer });
  value(query, '--limit <number>', 'Maximum results (default: 20, max: 100)', { parse: text => integer(text, true) });

  query.hook('preAction', cmd => {
    const { from, to } = cmd.opts<{ from?: string; to?: string }>();
    if (from && to && from > to) cmd.error('--from must not be after --to', { code: 'aside.dateRange' });
  });

  const instance = program.command('instance').description('Create, manage, and validate instances');
  instance.addHelpText('after', '\nThe daemon syncs every known instance. These commands never start the daemon.');
  const init = instance.command('init').description('Create an Aside instance');
  value(init, '--dir <path>', 'New instance directory', { required: true });
  value(init, '--name <name>', 'Instance display name', { required: true, trim: true });
  value(init, '--description <text>', 'One-line manifest summary', { required: true, trim: true });
  value(init, '--body <text>', 'Per-instance instructions', { allowEmpty: true });
  flag(init, '--tutorial', 'Include guided getting-started content');
  json(init);
  init.addHelpText('after', '\nCreates instance files directly, without registering the instance or starting the daemon.\nUse aside instance add --dir <path> to register it for ongoing sync.');
  for (const [operation, description] of Object.entries({
    add: 'Register existing instances for ongoing sync',
    forget: 'Remove instances from the known list',
    list: 'List all known instances',
    validate: 'Check an instance and report all diagnostics',
  })) {
    const cmd = instance.command(operation).description(description);
    json(cmd);
    if (operation === 'add' || operation === 'forget') directory(cmd, { repeatable: true, required: true });
    if (operation === 'validate') directory(cmd);
    if (operation === 'list') cmd.addHelpText('after', '\nLists the running daemon’s known instances, or the saved registry when stopped.');
    if (operation === 'forget') cmd.addHelpText('after', '\nRemoves registration only; keeps instance files. An instance in use remains loaded\nuntil its last client or tab disconnects. Using it again registers it again.');
  }

  const daemon = program.command('daemon').description('Manage the shared daemon and its login job');
  daemon.addHelpText('after', '\nOne daemon is shared by all Aside instances for your user.\nOnce started, the daemon keeps all known instances up to date until stopped.');
  const operations = {
    start: 'Start the shared daemon',
    install: 'Start the shared daemon at login',
    uninstall: 'Remove the saved login job for future logins; leave the running daemon as it is',
    status: 'Show the daemon, login job, and instances',
    automations: 'Inspect automation deadlines, running work, and observed runs',
    stop: 'Stop the shared daemon when idle; use --force if in use',
    run: 'Run the daemon host (internal)',
  };
  for (const [operation, description] of Object.entries(operations)) {
    const cmd = daemon.command(operation, { hidden: operation === 'run' }).description(description);
    json(cmd);
    cmd.addHelpText('after', '\nThis operation applies to the daemon shared by all Aside instances for your user and accepts no instance paths.');
    if (operation === 'start') {
      flag(cmd, '--foreground', 'Run in this process for a supervisor');
      cmd.addHelpText('after', '\nStarts a new daemon when none is running. Otherwise reuses the running daemon.\nThe daemon keeps all known instances up to date until stopped.\nIf this CLI has a later embedded build timestamp, it shuts down and replaces\nthe older daemon. Rebuilding the same source later counts as a newer build.\nAn equal or older build reuses the daemon; software versions must match.\nReports whether the daemon was started, replaced (with the previous PID), or reused.\nWith --foreground, reports once ready and stays running if it owns the daemon.');
    }
    if (operation === 'stop') {
      flag(cmd, '-f, --force', 'Stop even when other clients or tabs are connected');
      cmd.addHelpText('after', '\nWithout --force, refuses to stop while other clients or tabs are connected.\nWith --force, shuts down gracefully, draining requests and flushing calendar work\nbefore disconnecting clients and tabs. Clients can start the daemon again when they reconnect.');
    }
  }

  const plugin = program.command('plugin').description('Install, remove, or inspect agent plugins');
  for (const operation of ['install', 'remove', 'status']) {
    const cmd = plugin.command(operation).description({ install: 'Register this checkout and install the plugin', remove: 'Remove the plugin registration', status: 'Check the CLI build and both agents’ plugin registrations' }[operation]!);
    json(cmd);
    flag(cmd, '--legacy', 'Use the legacy MCP plugin package instead of GraphQL');
    if (operation !== 'status') {
      value(cmd, '--agent <agent>', 'Agent to configure', { required: true, choices: ['claude', 'codex'] });
      flag(cmd, '--print', 'Show commands without running them');
    }
    if (operation === 'install') flag(cmd, '--force', 'Replace a registration pointing elsewhere');
  }
  return program;
}

// Previously installed login jobs may still carry obsolete instance arguments.
// Their environment marker permits those arguments to be discarded on startup.
function savedJobArgs(args: string[]): string[] {
  const [command, operation, foreground, ...rest] = args;
  if (command !== 'daemon' || operation !== 'start' || foreground !== '--foreground'
    || !/^\d+$/.test(process.env.ASIDE_JOB_BUILT_AT ?? '')) return args;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--all') continue;
    if (arg === '--dir' && isAbsolute(rest[i + 1] ?? '')) { i++; continue; }
    if (arg.startsWith('--dir=') && isAbsolute(arg.slice(6))) continue;
    if (isAbsolute(arg)) continue;
    return args;
  }
  return [command, operation, foreground];
}

export function parseCommand(command: string, input: CommandInput): ParsedCommand {
  return Array.isArray(input) ? parseCli([command, ...input]) : input;
}

// Validation may stop before Commander reaches --json. Reparse the same option
// declarations without validation or actions to recover output intent. Commander
// still distinguishes required option values and the real -- terminator.
function requestsJson(program: Command, args: string[]): boolean {
  const commands: Command[] = [];
  function clone(source: Command): Command {
    const cmd = new Command(source.name())
      .enablePositionalOptions()
      .allowUnknownOption()
      .allowExcessArguments()
      .helpOption(false)
      .addHelpCommand(false)
      .configureOutput({ writeOut: () => {}, writeErr: () => {}, outputError: () => {} })
      .exitOverride()
      .action(() => {});
    for (const option of source.options) cmd.addOption(new Option(option.flags));
    // Also recognize the requested output format on invalid command groups.
    if (!source.options.some(option => option.long === '--json')) cmd.option('--json');
    commands.push(cmd);
    source.commands.forEach(child => cmd.addCommand(clone(child)));
    return cmd;
  }
  const probe = clone(program);
  try { probe.parse(args, { from: 'user' }); }
  catch (error) { if (!(error instanceof CommanderError)) throw error; }
  return commands.some(cmd => cmd.getOptionValue('json') === true);
}

export function parseCli(args: string[]): ParsedCommand {
  const program = createProgram();
  let selected = program;
  let output = '';
  let result: ParsedCommand | undefined;
  const outputConfig = { writeOut: (text: string) => { output += text; }, writeErr: () => {}, outputError: () => {} };
  const renderHelp = (cmd: Command): string => {
    const start = output.length;
    cmd.outputHelp();
    return output.slice(start);
  };
  function snapshot(cmd: Command, helpText?: string, displayText?: string): ParsedCommand {
    const path: string[] = [];
    for (let current = cmd; current.parent; current = current.parent) path.unshift(current.name());
    const options = cmd.opts<Record<string, string | string[] | boolean>>();
    const key = (name: string) => cmd.options.find(option => option.long === name)?.attributeName() ?? name;
    const all = (name: string): string[] | undefined => {
      if (name === 'target') return cmd.args[0] === undefined ? undefined : [cmd.args[0]];
      const val = options[key(name)];
      return val === undefined ? undefined : Array.isArray(val) ? val : [String(val)];
    };
    return {
      command: path[0] ?? '', operation: path[1], helpText, displayText,
      has: name => name === '--help' ? helpText !== undefined : all(name) !== undefined,
      get: name => all(name)?.[0], all,
      fail: message => { throw new Error(`${message}\n\n${renderHelp(cmd)}`); },
    };
  }
  function configure(cmd: Command): void {
    cmd.configureOutput(outputConfig).addHelpCommand(false).helpOption('-h, --help', 'Show help for this command');
    cmd.exitOverride(error => { selected = cmd; throw error; });
    if (cmd.commands.length === 0 && cmd.name() !== 'help') cmd.action(() => { selected = cmd; result = snapshot(cmd); });
    cmd.on('beforeHelp', () => { selected = cmd; });
    cmd.commands.forEach(configure);
  }
  program.command('help [command...]').description('Show help for a command').action((names: string[] = []) => {
    let cmd = program;
    for (const name of names) {
      const next = cmd.commands.find(child => child.name() === name);
      if (!next) cmd.error(`unknown command '${name}'`, { code: 'commander.unknownCommand' });
      cmd = next!;
    }
    selected = cmd;
    cmd.outputHelp();
    result = snapshot(cmd, output);
  });
  configure(program);
  try {
    if (args.length === 0) { program.outputHelp(); return snapshot(program, output); }
    program.parse(savedJobArgs(args), { from: 'user' });
  } catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    if (error.code === 'commander.version') return snapshot(selected, undefined, output);
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.help') {
      // Bare command groups are successful help requests, as in the original CLI.
      if (!output) selected.outputHelp();
      return snapshot(selected, output);
    }
    throw new CliParseError(`${error.message.replace(/^error: /, '')}\n\n${renderHelp(selected)}`, requestsJson(program, savedJobArgs(args)));
  }
  return result!;
}

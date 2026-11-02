// aside plugin — register this source checkout with an agent (see cli/spec.md).
// Each agent's own CLI makes the changes; this command never edits an agent's
// configuration files itself. It works on files and other programs directly
// and needs no daemon.
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { publishReceipt, publishReport, type Report } from './output.js';
import { parseCommand, type CommandInput } from './options.js';
import { ownProgram } from '../daemon/client.js';
import { formatScalar } from '../mcp/format.js';

const SKILL = 'aside';
type Surface = 'graphql' | 'legacy';
const pluginDirectory = (surface: Surface) => join('agent', surface);
const PACKAGE_FILES = ['.claude-plugin/marketplace.json', '.claude-plugin/plugin.json', '.mcp.json', `skills/${SKILL}/SKILL.md`];

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs one program with its arguments — no shell, so paths with spaces are safe.
export type Runner = (command: string, args: string[], options?: { cwd?: string }) => Promise<RunResult>;

const execRunner: Runner = (command, args, options) =>
  new Promise((done) => {
    execFile(command, args, { cwd: options?.cwd, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      done({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

// Everything the plugin command reads from its surroundings, injectable for tests.
export interface PluginContext {
  runner: Runner;
  home: string;
  cwd?: string;
  claudeConfigDir?: string;
  // Codex's own directory, where it caches installed plugins.
  codexHome?: string;
  // The source checkout this bundle was built in.
  root: string;
  surface?: Surface;
  node: string;
  script: string;
  // An agent's CLI, by name; null when it is not installed.
  find(name: 'claude' | 'codex'): string | null;
  // The CLI the plugins launch from PATH; injectable without changing PATH.
  findAside?(): string | null;
  out(line: string): void;
  report?: { value: Report; section: string; events: string[]; states: Record<string, unknown>; operations: Array<{ command: string; args: string[]; cwd?: string; print: boolean; result?: RunResult }> };
}

function onPath(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch { /* Try the next PATH entry. */ }
  }
  return null;
}

// The aside command the plugins launch, as the context resolves it.
function asideOnPath(ctx: PluginContext): string | null {
  return ctx.findAside ? ctx.findAside() : onPath('aside');
}

function findAgent(name: 'claude' | 'codex', home: string): string | null {
  const fallbacks = name === 'claude'
    ? [join(home, '.local', 'bin', 'claude')]
    // The ChatGPT desktop app carries the Codex CLI without putting it on PATH.
    : ['/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex'];
  return onPath(name) ?? fallbacks.find((p) => existsSync(p)) ?? null;
}

// The checkout root, two levels above the bundle (cli/dist/main.js), confirmed
// by the files the plugin command hands to the agents.
export function checkoutRoot(script: string): string {
  const root = resolve(dirname(script), '..', '..');
  for (const surface of ['graphql', 'legacy'] as const) for (const file of PACKAGE_FILES) {
    const needed = join(pluginDirectory(surface), file);
    if (!existsSync(join(root, needed))) {
      throw new Error(`aside plugin works from a source checkout: ${join(root, needed)} is missing.`);
    }
  }
  return root;
}

function defaultContext(): PluginContext {
  const { node, script } = ownProgram();
  const home = homedir();
  return {
    runner: execRunner,
    home,
    cwd: process.cwd(),
    claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ? resolve(process.env.CLAUDE_CONFIG_DIR) : join(home, '.claude'),
    codexHome: process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(home, '.codex'),
    root: checkoutRoot(script),
    node,
    script,
    find: (name) => findAgent(name, home),
    findAside: () => onPath('aside'),
    out: (line) => console.log(line),
  };
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try { return realpathSync(p); } catch { return resolve(p); }
  };
  return real(a) === real(b);
}

function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`;
}

function shownCommand(command: string, args: string[], cwd?: string): string {
  const invocation = [command, ...args].map(shellQuote).join(' ');
  return cwd ? `(cd ${shellQuote(cwd)} && ${invocation})` : invocation;
}

// Applies changes: runs each command, or with --print only shows it.
class Changes {
  count = 0;

  constructor(private ctx: PluginContext, private print: boolean) {}

  async run(command: string, args: string[], done: string, cwd?: string): Promise<void> {
    this.count++;
    const operation = { command, args, cwd, print: this.print, result: undefined as RunResult | undefined };
    this.ctx.report?.operations.push(operation);
    if (this.print) {
      this.ctx.out(shownCommand(command, args, cwd));
      return;
    }
    const result = await this.ctx.runner(command, args, cwd ? { cwd } : undefined);
    operation.result = result;
    if (result.code !== 0) {
      throw new Error(`${shownCommand(command, args, cwd)} failed:\n${(result.stderr || result.stdout).trim()}`);
    }
    this.ctx.out(done);
  }

}

// Ask an agent's CLI for its state. A query that fails is an error, never
// read as "nothing registered" — the plugin command would then act on a wrong picture.
async function json<T>(ctx: PluginContext, command: string, args: string[]): Promise<T> {
  const shown = [command, ...args].map(shellQuote).join(' ');
  const result = await ctx.runner(command, args);
  if (result.code !== 0) throw new Error(`${shown} failed:\n${(result.stderr || result.stdout).trim()}`);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(`${shown} did not print JSON.`);
  }
}

// Both agents read the same Claude-compatible marketplace and plugin files.
interface PluginNames {
  marketplace: string;
  surface: Surface;
  directory: string;
  plugin: string;
  // plugin@marketplace
  id: string;
}

function pluginNames(ctx: PluginContext): PluginNames {
  const surface = ctx.surface ?? 'graphql';
  const directory = join(ctx.root, pluginDirectory(surface));
  const manifest = JSON.parse(readFileSync(join(directory, '.claude-plugin', 'marketplace.json'), 'utf8')) as {
    name?: string;
    plugins?: Array<{ name?: string }>;
  };
  const plugin = manifest.plugins?.[0]?.name;
  if (!manifest.name || !plugin) throw new Error(`The checkout's ${pluginDirectory(surface)}/.claude-plugin/marketplace.json names no marketplace or plugin.`);
  return { marketplace: manifest.name, surface, directory, plugin, id: `${plugin}@${manifest.name}` };
}


// Switching the selected surface (or migrating the old package in this same
// checkout) is explicitly requested by install. Other checkouts still need --force.
function sameCheckoutPackage(ctx: PluginContext, path: string): boolean {
  return [join(ctx.root, 'agent'), ...(['graphql', 'legacy'] as const).map(surface => join(ctx.root, pluginDirectory(surface)))].some(candidate => samePath(path, candidate));
}

function registeredSurface(ctx: PluginContext, directory: string): Surface | null {
  if (samePath(directory, join(ctx.root, 'agent')) || samePath(directory, join(ctx.root, pluginDirectory('graphql')))) return 'graphql';
  if (samePath(directory, join(ctx.root, pluginDirectory('legacy')))) return 'legacy';
  try {
    const config = JSON.parse(readFileSync(join(directory, '.mcp.json'), 'utf8'));
    const server = config?.mcpServers?.aside;
    if (server?.command === 'aside' && Array.isArray(server.args) && server.args[0] === 'mcp' && server.args.every((arg: unknown) => typeof arg === 'string')) {
      return server.args.includes('--legacy') ? 'legacy' : 'graphql';
    }
  } catch { /* An unavailable or unfamiliar package does not establish its mode. */ }
  return null;
}

function checkRemovalSurface(ctx: PluginContext, names: PluginNames, marketplacePath: string | null): void {
  const surface = marketplacePath === null ? null : registeredSurface(ctx, marketplacePath);
  if (surface !== null && surface !== names.surface) {
    const legacy = surface === 'legacy';
    throw new Error(`Aside is registered for ${legacy ? 'legacy' : 'GraphQL'} MCP. Remove that package with aside plugin remove --agent <claude|codex>${legacy ? ' --legacy' : ''}. No changes were made.`);
  }
}

// --- Claude Code ---

export interface ClaudeState {
  // Where the marketplace of our name points; null when it is not registered.
  marketplacePath: string | null;
  marketplaceHere: boolean;
  userInstalled: boolean;
  // Installed for the user but turned off.
  userDisabled: boolean;
  // The plugin is installed at some other scope too.
  otherScopes: boolean;
  // The installed source, skill, or MCP mode differs from the selected package.
  needsRefresh: boolean;
  installations: ClaudeInstallation[];
  otherMarketplacePlugins: string[];
}

interface ClaudeInstallation {
  id: string;
  scope: string;
  projectPath?: string;
  enabled?: boolean;
  errors?: string[];
  installPath?: string;
  readFromFolder?: string;
  mcpServers?: Record<string, { command?: string; args?: string[] }>;
}

async function claudeState(ctx: PluginContext, bin: string, names: PluginNames): Promise<ClaudeState> {
  const marketplaces = await json<Array<{ name: string; path?: string; installLocation?: string }>>(ctx, bin, ['plugin', 'marketplace', 'list', '--json']);
  const plugins = await json<ClaudeInstallation[]>(ctx, bin, ['plugin', 'list', '--json']);
  if (!Array.isArray(marketplaces) || !Array.isArray(plugins)) throw new Error('claude plugin listing did not print a list.');
  const entry = marketplaces.find((m) => m.name === names.marketplace);
  const marketplacePath = entry ? entry.path ?? entry.installLocation ?? '' : null;
  const mine = plugins.filter((p) => p.id === names.id);
  for (const installed of mine) {
    if (installed.errors !== undefined && (!Array.isArray(installed.errors) || installed.errors.some(error => typeof error !== 'string'))) {
      throw new Error('claude plugin list --json reported invalid load errors for Aside.');
    }
  }
  return {
    marketplacePath,
    marketplaceHere: marketplacePath !== null && samePath(marketplacePath, names.directory),
    userInstalled: mine.some((p) => p.scope === 'user'),
    userDisabled: mine.some((p) => p.scope === 'user' && p.enabled === false),
    otherScopes: mine.some((p) => p.scope !== 'user'),
    needsRefresh: mine.some((p) => {
      const server = p.mcpServers?.aside;
      return p.readFromFolder !== undefined && !samePath(p.readFromFolder, names.directory)
        || server !== undefined && (server.command !== 'aside' || server.args?.[0] !== 'mcp' || server.args.includes('--legacy') !== (names.surface === 'legacy'))
        || p.installPath !== undefined && existsSync(p.installPath) && !sameFiles(tree(names.directory), tree(p.installPath));
    }),
    installations: mine,
    otherMarketplacePlugins: plugins.filter(p => p.id !== names.id && p.id.endsWith(`@${names.marketplace}`)).map(p => p.id),
  };
}

interface ClaudeScope {
  scope: 'user' | 'project' | 'local';
  cwd?: string;
}

interface ClaudeSetting extends ClaudeScope {
  file: string;
  enabled: boolean;
}

interface ClaudeInstallTarget extends ClaudeScope {
  file: string;
}

function scopedEnabled(file: string, id: string): boolean | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Cannot inspect Claude plugin setting in ${file}.`);
  }
  let settings: { enabledPlugins?: Record<string, unknown> };
  try { settings = JSON.parse(text); }
  catch { throw new Error(`Cannot parse Claude settings ${file}.`); }
  const value = settings?.enabledPlugins?.[id];
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`Cannot preserve the non-boolean plugin setting in ${file}.`);
  return value;
}

// Claude lists merged enabled state. Snapshot the actual per-scope choices;
// otherwise a local disable could inadvertently disable the user installation.
async function claudeRestorePlan(ctx: PluginContext, names: PluginNames, state: ClaudeState): Promise<{ installs: ClaudeInstallTarget[]; settings: ClaudeSetting[] }> {
  if (state.otherMarketplacePlugins.length) throw new Error(`Cannot replace ${names.marketplace} while other plugins use it: ${state.otherMarketplacePlugins.join(', ')}. Repoint their marketplace through Claude Code first; no changes were made.`);
  const installs: ClaudeScope[] = [{ scope: 'user' }];
  const directories = new Set<string>([ctx.cwd ?? process.cwd()]);
  for (const installed of state.installations) {
    if (installed.scope === 'user') continue;
    if (installed.scope !== 'project' && installed.scope !== 'local') throw new Error(`Cannot restore ${names.id} at ${installed.scope} scope through Claude Code; no marketplace changes were made.`);
    const cwd = installed.projectPath;
    if (!cwd || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Cannot restore ${installed.scope} installation of ${names.id}: its project directory is missing or unavailable (${cwd ?? 'not reported'}). No marketplace changes were made.`);
    directories.add(cwd);
    if (!installs.some(p => p.scope === installed.scope && p.cwd !== undefined && samePath(p.cwd, cwd))) installs.push({ scope: installed.scope, cwd });
  }
  const settings: ClaudeSetting[] = [];
  const found = new Set<string>();
  const filesByScope = new Map<string, string>();
  const scopeKey = (scope: ClaudeScope) => `${scope.scope}:${scope.cwd ? realpathSync(scope.cwd) : ''}`;
  const remember = (scope: ClaudeScope, file: string) => {
    filesByScope.set(scopeKey(scope), file);
    const enabled = scopedEnabled(file, names.id);
    if (enabled !== undefined) {
      found.add(scopeKey(scope));
      if (!settings.some(s => samePath(s.file, file))) settings.push({ ...scope, file, enabled });
    }
  };
  remember({ scope: 'user' }, join(ctx.claudeConfigDir ?? join(ctx.home, '.claude'), 'settings.json'));
  for (const cwd of directories) {
    remember({ scope: 'project', cwd }, join(cwd, '.claude/settings.json'));
    // Local settings in a git worktree belong to the main checkout. A failed
    // git query means a plain directory, where they belong beside the project.
    const git = await ctx.runner('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
    const common = git.stdout.trim();
    if (git.code !== 0 && !git.stderr.includes('not a git repository')) throw new Error(`Cannot locate Claude local settings in ${cwd}: git could not identify the repository. No marketplace changes were made.`);
    if (git.code === 0 && (!isAbsolute(common) || !common.endsWith('/.git'))) throw new Error(`Cannot safely locate Claude local settings in ${cwd}. No marketplace changes were made.`);
    const repository = dirname(common);
    const owned = (path: string) => !existsSync(path) || !process.getuid || statSync(path).uid === process.getuid();
    const local = git.code === 0 && process.platform !== 'win32' && !samePath(repository, ctx.home)
      && owned(repository) && owned(common) && owned(join(repository, '.claude')) ? repository : cwd;
    remember({ scope: 'local', cwd }, join(local, '.claude/settings.local.json'));
  }
  for (const installed of state.installations) {
    if (!found.has(scopeKey({ scope: installed.scope as ClaudeScope['scope'], cwd: installed.scope === 'user' ? undefined : installed.projectPath }))) {
      throw new Error(`Cannot preserve the ${installed.scope} enabled setting for ${names.id}${installed.projectPath ? ` in ${installed.projectPath}` : ''}: its scope setting was not found. No marketplace changes were made.`);
    }
  }
  return { installs: installs.map(target => ({ ...target, file: filesByScope.get(scopeKey(target))! })), settings };
}

function claudeManual(ctx: PluginContext, names: PluginNames, remove: boolean): string[] {
  return remove
    ? [`claude plugin uninstall ${names.id} --scope user`, `claude plugin marketplace remove ${names.marketplace}`]
    : [`claude plugin marketplace add ${shellQuote(names.directory)}`, `claude plugin install ${names.id} --scope user`];
}

async function manageClaudePlugin(ctx: PluginContext, opts: Options): Promise<void> {
  const names = pluginNames(ctx);
  const bin = ctx.find('claude');
  if (!bin) {
    throw new Error(`The claude command was not found. Install Claude Code, or run these yourself:\n${claudeManual(ctx, names, opts.remove).map((c) => `  ${c}`).join('\n')}`);
  }
  const state = await claudeState(ctx, bin, names);
  const changes = new Changes(ctx, opts.print);

  if (opts.remove) {
    checkRemovalSurface(ctx, names, state.marketplacePath);
    if (state.userInstalled) {
      await changes.run(bin, ['plugin', 'uninstall', names.id, '--scope', 'user'], `claude: uninstalled ${names.id} for your user`);
    }
    // Other installations still rely on the marketplace; leave it for them.
    if (state.marketplacePath !== null && sameCheckoutPackage(ctx, state.marketplacePath) && !state.otherScopes && !state.otherMarketplacePlugins.length) {
      await changes.run(bin, ['plugin', 'marketplace', 'remove', names.marketplace], `claude: removed marketplace ${names.marketplace}`);
    }
    if (changes.count === 0) ctx.out('claude: nothing to remove');
    return;
  }

  const replacing = state.marketplacePath !== null && !state.marketplaceHere;
  const refreshing = state.marketplaceHere && state.needsRefresh;
  let restore: Awaited<ReturnType<typeof claudeRestorePlan>> | undefined;
  if (replacing || refreshing) {
    if (replacing && !sameCheckoutPackage(ctx, state.marketplacePath!) && !opts.force) {
      throw new Error(`claude: marketplace ${names.marketplace} already points at ${state.marketplacePath}, not this checkout's agent directory (${names.directory}). Pass --force to replace it.`);
    }
    // Marketplace removal uninstalls its plugins. Build a complete restoration
    // plan before that destructive step, including project destinations.
    try { restore = await claudeRestorePlan(ctx, names, state); }
    catch (error) { throw new Error(`${(error as Error).message}\nNo marketplace changes were made.`); }
  }
  try {
    if (replacing || refreshing) await changes.run(bin, ['plugin', 'marketplace', 'remove', names.marketplace], `claude: removed marketplace ${names.marketplace} (${state.marketplacePath})`);
    if (!state.marketplaceHere || refreshing) await changes.run(bin, ['plugin', 'marketplace', 'add', names.directory], `claude: added marketplace ${names.marketplace} → ${names.directory}`);
    const current = restore ? opts.print ? { installations: [] } : await claudeState(ctx, bin, names) : state;
    const installs: ClaudeScope[] = restore?.installs ?? [{ scope: 'user' }];
    for (const target of installs) {
      if (!current.installations.some(p => p.scope === target.scope && (target.scope === 'user' || p.projectPath && samePath(p.projectPath, target.cwd!)))) {
        await changes.run(bin, ['plugin', 'install', names.id, '--scope', target.scope], `claude: installed ${names.id} at ${target.scope} scope${target.cwd ? ` in ${target.cwd}` : ''}`, target.cwd);
      }
    }
    for (const setting of restore?.settings ?? []) {
      const installedByPlan = restore!.installs.some(target => target.scope === setting.scope && samePath(target.file, setting.file));
      if (opts.print ? !setting.enabled || !installedByPlan : scopedEnabled(setting.file, names.id) !== setting.enabled) {
        const operation = setting.enabled ? 'enable' : 'disable';
        await changes.run(bin, ['plugin', operation, names.id, '--scope', setting.scope], `claude: restored ${setting.scope} plugin ${operation}d state${setting.cwd ? ` in ${setting.cwd}` : ''}`, setting.cwd);
      }
    }
    if (restore && !opts.print) {
      const confirmed = await claudeState(ctx, bin, names);
      if (!confirmed.marketplaceHere || confirmed.needsRefresh || installs.some(target => !confirmed.installations.some(p => p.scope === target.scope && (target.scope === 'user' || p.projectPath && samePath(p.projectPath, target.cwd!)))) || restore.settings.some(s => scopedEnabled(s.file, names.id) !== s.enabled)) {
        throw new Error('Claude did not confirm every restored installation and enabled setting.');
      }
    }
  } catch (error) {
    if (!restore || opts.print) throw error;
    const commands = [
      shownCommand(bin, ['plugin', 'marketplace', 'add', names.directory]),
      ...restore.installs.map(s => shownCommand(bin, ['plugin', 'install', names.id, '--scope', s.scope], s.cwd)),
      ...restore.settings.filter(s => !s.enabled || !restore!.installs.some(target => target.scope === s.scope && samePath(target.file, s.file))).map(s => shownCommand(bin, ['plugin', s.enabled ? 'enable' : 'disable', names.id, '--scope', s.scope], s.cwd)),
    ];
    throw new Error(`${(error as Error).message}\nMarketplace replacement or restoration is incomplete. After fixing the reported error, restore the previous scopes and choices with:\n${commands.map(c => `  ${c}`).join('\n')}`);
  }
  if (opts.print && state.userDisabled) ctx.out(`claude: configured but disabled; enable with claude plugin enable ${names.id}`);
  if (!opts.print) {
    if (changes.count) ctx.out('');
    reportBuilds(ctx);
    reportAgent(ctx, 'Claude Code', bin);
    reportClaude(ctx, names, await claudeState(ctx, bin, names));
    if (changes.count === 0) ctx.out('claude: configuration unchanged');
    else ctx.out('claude: start a new session, or run /reload-plugins in an open one');
  }
}

// --- Codex ---

// Both agents install only the selected agent/graphql or agent/legacy package.
// Its MCP entry runs `aside mcp` (with --legacy for the legacy package)
// from PATH; no runtime build outputs or launcher scripts belong in its cache.
interface CodexNames extends PluginNames {
  // Where Codex keeps its copy of the installed plugin.
  cache: string;
}

class PluginRecoveryError extends Error {
  constructor(message: string, readonly fixes: string[]) { super(message); }
}

function codexNames(ctx: PluginContext): CodexNames {
  const names = pluginNames(ctx);
  const manifest = JSON.parse(readFileSync(join(names.directory, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: string };
  return {
    ...names,
    cache: join(ctx.codexHome ?? join(ctx.home, '.codex'), 'plugins', 'cache', names.marketplace, names.plugin, manifest.version ?? 'unknown'),
  };
}

// Every file under a directory, by relative path.
function tree(dir: string, prefix = ''): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files;
    throw error;
  }
  for (const name of names) {
    if (name === '.DS_Store') continue;
    const path = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(path).isDirectory()) for (const [k, v] of tree(path, rel)) files.set(k, v);
    else files.set(rel, readFileSync(path));
  }
  return files;
}

function sameFiles(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [file, content] of a) {
    const other = b.get(file);
    if (!other || !other.equals(content)) return false;
  }
  return true;
}

export interface CodexState {
  // Where the marketplace of our name points; null when it is not added.
  marketplacePath: string | null;
  marketplaceHere: boolean;
  installed: boolean;
  // Installed but turned off in Codex.
  disabled: boolean;
  // Codex's copy matches the plugin manifests, MCP configuration, and skills.
  current: boolean;
  otherMarketplacePlugins: string[];
}

async function codexState(ctx: PluginContext, bin: string, names: CodexNames, recoveryOperation: 'install' | 'remove' = 'install'): Promise<CodexState> {
  let listed: { marketplaces?: Array<{ name: string; root?: string }> };
  try {
    listed = await json(ctx, bin, ['plugin', 'marketplace', 'list', '--json']);
  } catch (error) {
    const message = (error as Error).message;
    // Codex loads every marketplace before listing them, so a moved manifest
    // prevents even the normal migration from inspecting the registration.
    if (message.split('\n').some(line => line.startsWith(`- \`${names.marketplace}\` at `)
      && line.endsWith(': marketplace root does not contain a supported manifest'))) {
      throw new PluginRecoveryError(message, [
        shownCommand(bin, ['plugin', 'marketplace', 'remove', names.marketplace]),
        pluginCommand(ctx, 'codex', recoveryOperation),
      ]);
    }
    throw error;
  }
  const plugins = await json<{ installed?: Array<{ pluginId: string; enabled?: boolean }> }>(ctx, bin, ['plugin', 'list', '--json']);
  if (!Array.isArray(listed?.marketplaces)) throw new Error('codex plugin marketplace list --json did not print a marketplace list.');
  if (!Array.isArray(plugins?.installed)) throw new Error('codex plugin list --json did not print an installed-plugin list.');
  const entry = listed.marketplaces.find((m) => m?.name === names.marketplace);
  const marketplacePath = entry ? entry.root ?? '' : null;
  const mine = plugins.installed.find((p) => p?.pluginId === names.id);
  if (mine?.enabled !== undefined && typeof mine.enabled !== 'boolean') {
    throw new Error('codex plugin list --json reported an invalid enabled state for Aside.');
  }
  return {
    marketplacePath,
    marketplaceHere: marketplacePath !== null && samePath(marketplacePath, names.directory),
    installed: mine !== undefined,
    disabled: mine?.enabled === false,
    current: mine !== undefined && sameFiles(tree(names.directory), tree(names.cache)),
    otherMarketplacePlugins: plugins.installed.filter(p => typeof p?.pluginId === 'string' && p.pluginId !== names.id && p.pluginId.endsWith(`@${names.marketplace}`)).map(p => p.pluginId),
  };
}

function codexManual(ctx: PluginContext, names: CodexNames, remove: boolean): string[] {
  return remove
    ? [`codex plugin remove ${names.id}`, `codex plugin marketplace remove ${names.marketplace}`]
    : [`codex plugin marketplace add ${shellQuote(names.directory)}`, `codex plugin add ${names.id}`];
}

async function manageCodexPlugin(ctx: PluginContext, opts: Options): Promise<void> {
  const names = codexNames(ctx);
  const bin = ctx.find('codex');
  if (!bin) {
    throw new Error(`The codex command was not found. Install Codex, or run these yourself:\n${codexManual(ctx, names, opts.remove).map((c) => `  ${c}`).join('\n')}`);
  }
  const state = await codexState(ctx, bin, names, opts.remove ? 'remove' : 'install');
  const changes = new Changes(ctx, opts.print);

  if (opts.remove) {
    checkRemovalSurface(ctx, names, state.marketplacePath);
    if (state.installed) {
      await changes.run(bin, ['plugin', 'remove', names.id], `codex: uninstalled ${names.id}`);
    }
    if (state.marketplacePath !== null && sameCheckoutPackage(ctx, state.marketplacePath) && !state.otherMarketplacePlugins.length) {
      await changes.run(bin, ['plugin', 'marketplace', 'remove', names.marketplace], `codex: removed marketplace ${names.marketplace}`);
    }
    if (changes.count === 0) ctx.out('codex: nothing to remove');
    return;
  }

  if (state.marketplacePath !== null && !state.marketplaceHere && !sameCheckoutPackage(ctx, state.marketplacePath) && !opts.force) {
    throw new Error(`codex: marketplace ${names.marketplace} already points at ${state.marketplacePath}, not this checkout's agent directory (${names.directory}). Pass --force to replace it.`);
  }
  if (state.marketplacePath !== null && !state.marketplaceHere && state.otherMarketplacePlugins.length) {
    throw new Error(`Cannot replace ${names.marketplace} while other plugins use it: ${state.otherMarketplacePlugins.join(', ')}. Repoint their marketplace through Codex first; no changes were made.`);
  }

  if (!(state.marketplaceHere && state.current)) {
    // The CLI has no operation to restore a disabled plugin after installation.
    // Do not let a refresh silently turn a deliberately disabled plugin on.
    if (state.disabled) {
      throw new Error('codex: Aside is disabled and needs a plugin refresh. To preserve that choice, no changes were made. Enable the plugin in Codex before rerunning aside plugin install, then disable it again if desired.');
    }
    if (state.marketplacePath !== null && !state.marketplaceHere) {
      await changes.run(bin, ['plugin', 'marketplace', 'remove', names.marketplace], `codex: removed marketplace ${names.marketplace} (${state.marketplacePath})`);
    }
    if (!state.marketplaceHere) {
      await changes.run(bin, ['plugin', 'marketplace', 'add', names.directory], `codex: added marketplace ${names.marketplace} → ${names.directory}`);
    }
    // Installing again is how Codex refreshes its copy.
    await changes.run(bin, ['plugin', 'add', names.id], state.installed ? `codex: refreshed ${names.id}` : `codex: installed ${names.id}`);
  }
  if (opts.print && state.disabled) ctx.out('codex: installed but disabled; enable the plugin in Codex, then start a new session.');
  if (!opts.print) {
    if (changes.count) ctx.out('');
    reportBuilds(ctx);
    reportAgent(ctx, 'Codex', bin);
    reportCodex(ctx, names, await codexState(ctx, bin, names));
    if (changes.count === 0) ctx.out('codex: configuration unchanged');
    else ctx.out(`codex: start a new session, then invoke the skill with $${SKILL}`);
  }
}

// --- status ---

function installCommand(ctx: PluginContext, agent: 'claude' | 'codex', force = false): string {
  return pluginCommand(ctx, agent, 'install', force);
}

function pluginCommand(ctx: PluginContext, agent: 'claude' | 'codex', operation: 'install' | 'remove', force = false): string {
  const aside = asideOnPath(ctx);
  const linkedRoot = aside ? pathCheckout(aside) : null;
  const command = linkedRoot && !samePath(linkedRoot, ctx.root) ? [ctx.node, ctx.script] : ['aside'];
  return [...command, 'plugin', operation, '--agent', agent, ...(ctx.surface === 'legacy' ? ['--legacy'] : []), ...(force ? ['--force'] : [])].map(shellQuote).join(' ');
}

function pathCheckout(command: string): string | null {
  try {
    const script = realpathSync(command);
    const root = resolve(dirname(script), '..', '..');
    // PATH can still point at an older checkout while this checkout is upgraded.
    // Recognize its former package for diagnostics, without accepting it as an
    // installable source for the current split-package command.
    if (PACKAGE_FILES.every(file => existsSync(join(root, 'agent', file)))) return root;
    return checkoutRoot(script);
  } catch { return null; }
}

function reportInformation(ctx: PluginContext, label: string, value: unknown): void {
  if (!ctx.report) return;
  let section = ctx.report.value.sections.find(section => section.name === ctx.report!.section);
  if (!section) { section = { name: ctx.report.section, fields: {} }; ctx.report.value.sections.push(section); }
  section.fields![label] = value;
}

function reportCheck(ctx: PluginContext, passed: boolean, label: string, detail: string): void {
  const section = ctx.report!;
  section.value.checks.push({ code: `${section.section}_${label}`.toLowerCase().replace(/[^a-z0-9]+/g, '_'),
    label, group: section.section, passed, ...(!passed ? { problems: [detail] } : {}) });
}

function reportFix(ctx: PluginContext, instruction: string): void {
  const check = [...ctx.report!.value.checks].reverse().find(check => !check.passed);
  if (check) (check.fixes ??= []).push(instruction);
}

function reportAgent(ctx: PluginContext, name: string, bin: string | null): void {
  ctx.report!.section = name;
  reportInformation(ctx, 'CLI', bin);
  reportCheck(ctx, bin !== null, 'CLI', bin ?? 'not found');
}

function reportBuilds(ctx: PluginContext): void {
  ctx.report!.section = 'CLI';
  reportInformation(ctx, 'Checkout', ctx.root);
  const aside = asideOnPath(ctx);
  reportInformation(ctx, 'aside on PATH', aside);
  const linkedRoot = aside ? pathCheckout(aside) : null;
  if (linkedRoot) reportInformation(ctx, 'PATH checkout', linkedRoot);
  const differentCheckout = linkedRoot !== null && !samePath(linkedRoot, ctx.root);
  reportCheck(ctx, aside !== null && !differentCheckout, 'aside on PATH', aside === null ? 'not found'
    : differentCheckout ? `${aside} (uses checkout ${linkedRoot})` : aside);
  const build = `bash ${shellQuote(join(ctx.root, 'build.sh'))}`;
  if (!aside) reportFix(ctx, `run ${build}, then add npm's global bin directory to PATH.`);
  else if (differentCheckout) reportFix(ctx, `run ${build} to link aside to this CLI checkout.`);
  let missingBuild = false;
  for (const [label, path] of [['CLI launcher', 'cli/dist/main.js'], ['CLI bundle', 'cli/dist/runtime.js'], ['regex worker', 'cli/dist/regex-worker.js'], ['webapp bundle', 'webapp/dist/app.js']]) {
    reportInformation(ctx, label, join(ctx.root, path));
    const present = existsSync(join(ctx.root, path));
    reportCheck(ctx, present, label, present ? 'present' : 'missing');
    missingBuild ||= !present;
  }
  if (missingBuild) reportFix(ctx, `rebuild missing files with ${build}`);
  if (process.platform === 'darwin') {
    reportInformation(ctx, 'calendar helper', join(ctx.root, 'cli/dist/aside-cal'));
    const present = existsSync(join(ctx.root, 'cli/dist/aside-cal'));
    reportCheck(ctx, present, 'calendar helper', present ? 'present' : 'missing; calendar sync unavailable');
    if (!present) reportFix(ctx, `bash ${shellQuote(join(ctx.root, 'cli/native/build.sh'))}`);
  }
}

function reportMarketplace(ctx: PluginContext, names: PluginNames, state: Pick<ClaudeState, 'marketplacePath' | 'marketplaceHere'>): void {
  reportInformation(ctx, 'MCP interface', names.surface);
  reportInformation(ctx, 'Marketplace', state.marketplacePath);
  reportInformation(ctx, 'Expected marketplace', names.directory);
  reportCheck(ctx, state.marketplaceHere, 'Marketplace', state.marketplacePath === null ? 'not registered'
    : `${state.marketplacePath} (${state.marketplaceHere ? 'matches CLI checkout' : 'different from CLI checkout'})`);

}

function reportClaude(ctx: PluginContext, names: PluginNames, state: ClaudeState): void {
  ctx.report!.states.claude = state;
  reportMarketplace(ctx, names, state);
  reportCheck(ctx, state.userInstalled && !state.userDisabled, 'Plugin', state.userInstalled
    ? state.userDisabled ? 'installed for your user, disabled' : 'installed for your user, enabled'
    : state.otherScopes ? 'installed for a project only' : 'not installed');
  if (state.needsRefresh) reportCheck(ctx, false, 'Plugin source', 'out of date; the installed package, skill, or MCP command differs from the selected surface');
  const failed = state.installations.filter(installation => installation.errors?.length);
  if (state.installations.length) reportCheck(ctx, failed.length === 0, 'Plugin load', failed.length ? 'errors reported by Claude' : 'no errors reported by Claude');
  const sources = new Set<string>();
  for (const installation of failed) {
    const context = `${installation.scope}${installation.projectPath ? `, ${installation.projectPath}` : ''}`;
    for (const error of installation.errors!) {
      ctx.out(`          ${context}: ${(error.trim() || '(empty diagnostic)').replaceAll('\n', '\n            ')}`);
    }
    const source = installation.readFromFolder ?? installation.installPath ?? (state.marketplaceHere ? names.directory : undefined);
    if (source) sources.add(source);
  }
  if (failed.length) {
    for (const source of sources) reportFix(ctx, shownCommand('claude', ['plugin', 'validate', source]));
    reportFix(ctx, `fix the reported plugin error, then run /reload-plugins in an open Claude session or start a new session. Recheck with ${shownCommand(ctx.node, [ctx.script, 'plugin', 'status', ...(ctx.surface === 'legacy' ? ['--legacy'] : [])])}.`);
  }
  if (!state.marketplaceHere || !state.userInstalled || state.needsRefresh) reportFix(ctx, installCommand(ctx, 'claude', state.marketplacePath !== null && !state.marketplaceHere && !sameCheckoutPackage(ctx, state.marketplacePath)));
  if (state.userDisabled) reportFix(ctx, `claude plugin enable ${names.id}`);
}

function reportCodex(ctx: PluginContext, names: CodexNames, state: CodexState): void {
  ctx.report!.states.codex = state;
  reportMarketplace(ctx, names, state);
  reportCheck(ctx, state.installed && !state.disabled, 'Plugin', !state.installed ? 'not installed' : state.disabled ? 'installed, disabled' : 'installed, enabled');
  if (state.installed) reportCheck(ctx, state.current, 'Plugin files', state.current ? 'match CLI checkout' : 'differ from CLI checkout');
  const needsInstall = !state.marketplaceHere || !state.installed || !state.current;
  if (state.disabled) reportFix(ctx, needsInstall ? 'enable the plugin in Codex before running aside plugin install; you can disable it again afterwards.' : 'enable the plugin in Codex, then start a new session.');
  if (needsInstall) reportFix(ctx, installCommand(ctx, 'codex', state.marketplacePath !== null && !state.marketplaceHere && !sameCheckoutPackage(ctx, state.marketplacePath)));
}

async function status(ctx: PluginContext): Promise<void> {
  reportBuilds(ctx);
  const failures: string[] = [];
  const claude = ctx.find('claude');
  reportAgent(ctx, 'Claude Code', claude);
  if (!claude) {
    reportFix(ctx, `install Claude Code, then run ${installCommand(ctx, 'claude')}`);
  } else {
    try {
      const names = pluginNames(ctx);
      reportClaude(ctx, names, await claudeState(ctx, claude, names));
    } catch (error) {
      const message = (error as Error).message;
      reportCheck(ctx, false, 'Registration', `inspection failed — ${message}`);
      failures.push(`claude: ${message}`);
    }
  }
  const codex = ctx.find('codex');
  reportAgent(ctx, 'Codex', codex);
  if (!codex) {
    reportFix(ctx, `install Codex, then run ${installCommand(ctx, 'codex')}`);
  } else {
    try {
      const names = codexNames(ctx);
      reportCodex(ctx, names, await codexState(ctx, codex, names));
    } catch (error) {
      const message = (error as Error).message;
      reportCheck(ctx, false, 'Registration', `inspection failed — ${message}`);
      if (error instanceof PluginRecoveryError) for (const fix of error.fixes) reportFix(ctx, fix);
      failures.push(`codex: ${message}`);
    }
  }
  if (failures.length) throw new Error(`Plugin inspection failed:\n${failures.join('\n')}`);
}

interface Options {
  remove: boolean;
  force: boolean;
  print: boolean;
}

export async function runPlugin(args: CommandInput, context?: PluginContext): Promise<void> {
  const options = parseCommand('plugin', args);
  if (options.helpText) { (context?.out ?? console.log)(options.helpText); return; }
  const operation = options.operation!;
  const agent = options.get('--agent');
  const original = context ?? defaultContext();
  const report: Report = { title: `Aside plugin ${operation}`, data: {}, sections: [], checks: [] };
  const events: string[] = [];
  const ctx: PluginContext = { ...original, surface: options.has('--legacy') ? 'legacy' : 'graphql', report: { value: report, section: 'CLI', events, states: {}, operations: [] }, out: line => {
    if (!line.trim()) return;
    if (/^\s/.test(line)) {
      const check = [...report.checks].reverse().find(check => !check.passed);
      if (check) { (check.problems ??= []).push(line.trim()); return; }
    }
    events.push(line);
  } };
  let failure: unknown;
  try {
    if (operation === 'status') { await status(ctx); return; }

    const opts: Options = { remove: operation === 'remove', force: options.has('--force'), print: options.has('--print') };
    if (!opts.remove && !opts.print && !asideOnPath(ctx)) {
      throw new Error('The aside command was not found on PATH. Run ./build.sh to build and link it, and add npm\'s global bin directory to PATH before installing the plugin.');
    }
    if (agent === 'claude') await manageClaudePlugin(ctx, opts);
    else await manageCodexPlugin(ctx, opts);
  } catch (error) {
    failure = error;
    if (!options.has('--json') && operation !== 'status' && error instanceof PluginRecoveryError) {
      throw new Error(`${error.message}\n${error.fixes.map(fix => `Fix: ${fix}`).join('\n')}`);
    }
    throw error;
  }
  finally {
    if (events.length) report.sections.push({ name: options.has('--print') ? 'Commands' : 'Results', entries: events.map(name => ({ name })) });
    if (failure) report.checks.push({ code: 'plugin_operation', label: `Plugin ${operation}`, passed: false, problems: [failure instanceof Error ? failure.message : String(failure)],
      ...(failure instanceof PluginRecoveryError ? { fixes: failure.fixes } : {}) });
    report.data = { checkout: ctx.root, surface: ctx.surface, information: report.sections, agents: ctx.report!.states, operations: ctx.report!.operations, events };
    const out = options.has('--json') ? original.out : (text: string) => text.split('\n').forEach(original.out);
    if (operation === 'status') publishReport(report, `plugin ${operation}`, options.has('--json'), out);
    else {
      // The CLI prints thrown errors on stderr. Receipts keep completed work
      // and verification failures, without repeating the operation error.
      const lines = events.map(formatScalar);
      for (const check of report.checks.filter(check => !check.passed && check.code !== 'plugin_operation')) {
        lines.push(`Error: ${check.group ? `${check.group}: ` : ''}${check.label}`);
        for (const problem of check.problems ?? []) lines.push(...problem.split('\n').map(line => `  ${formatScalar(line)}`));
        for (const fix of check.fixes ?? []) lines.push(`Fix: ${formatScalar(fix)}`);
      }
      publishReceipt(report, `plugin ${operation}`, lines, options.has('--json'), out);
    }
  }
}

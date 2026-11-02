import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCli } from '../src/commands/options.js';
import { VERSION } from '../src/version.js';

// Exercise user invocations, including cases that used to be split between the
// handwritten top-level dispatcher and individual command parsers.
describe('CLI command tree', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('defaults to GraphQL and requires an MCP flag to opt into legacy tools', () => {
    expect(parseCli(['mcp']).has('--legacy')).toBe(false);
    expect(parseCli(['mcp', '--legacy', '--dir', '/tmp/aside']).has('--legacy')).toBe(true);
    expect(parseCli(['mcp', '--help']).helpText).toContain('--legacy');
    expect(parseCli(['mcp', '--help']).helpText).toContain('GraphQL');
    expect(parseCli(['mcp', '--help']).helpText).not.toContain('--graphql');
    expect(() => parseCli(['mcp', '--legacy', '--legacy'])).toThrow(/duplicate option/);
    expect(() => parseCli(['mcp', '--legacy', '--graphql'])).toThrow(/unknown option/);
    expect(() => parseCli(['mcp', '--graphql', '--legacy'])).toThrow(/unknown option/);
    expect(() => parseCli(['instance', 'list', '--legacy'])).toThrow(/unknown option/);
    expect(() => parseCli(['mcp', '--graphql'])).toThrow(/unknown option/);
    expect(() => parseCli(['instance', 'list', '--graphql'])).toThrow(/unknown option/);
  });
  it.each([[], ['--help'], ['-h'], ['help']])('shows root help for %j', (...args) => {
    const help = parseCli(args).helpText!;
    expect(help).toContain('Usage: aside [options] [command]');
    expect(help).toContain('Examples:');
    expect(help).toContain('plugin');
  });

  it.each([['--version'], ['-V']])('reports the package version for %j', (...args) => {
    expect(parseCli(args).displayText).toBe(`${VERSION}\n`);
  });

  it('supports nested help through either spelling and shows only relevant options', () => {
    const explicit = parseCli(['artifact', 'query', '--help']);
    expect(parseCli(['help', 'artifact', 'query']).helpText).toBe(explicit.helpText);
    expect(explicit.helpText).toContain('--offset <number>');
    expect(explicit.helpText).toContain('choices: "index", "metadata", "full"');
    expect(explicit.helpText).not.toContain('--body');
    expect(parseCli(['artifact', 'create', '--help']).helpText).toContain('Display name (required)');
    expect(parseCli(['daemon', '--help']).helpText).not.toContain('run [options]');
    expect(parseCli(['daemon', 'run', '--help']).helpText).not.toContain('--long-running');
  });

  it.each(['artifact', 'daemon', 'instance', 'plugin', 'graphql'])('bare %s opens its help', command => {
    expect(parseCli([command]).helpText).toContain(`Usage: aside ${command}`);
  });

  it('accepts GraphQL documents and variables with strict input-source options', () => {
    const parsed = parseCli(['graphql', 'query', '--document', '{ __typename }', '--variables', '{}', '--operation-name', 'Read']);
    expect(parsed).toMatchObject({ command: 'graphql', operation: 'query' });
    expect(parsed.get('--document')).toBe('{ __typename }');
    expect(parseCli(['graphql', 'mutate', '--document-file', '-', '--variables-file', 'vars.json', '--dir', '/instance', '--json']).operation).toBe('mutate');
    expect(parseCli(['graphql', 'query', '--help']).helpText).toContain('GraphQL source text');
    expect(parseCli(['help', 'graphql', 'mutate']).helpText).toBe(parseCli(['graphql', 'mutate', '--help']).helpText);
    expect(() => parseCli(['graphql', 'query'])).toThrow(/provide --document or --document-file/);
    expect(() => parseCli(['graphql', 'query', '--document', '{}', '--document-file', 'request.graphql'])).toThrow(/cannot be used/);
    expect(() => parseCli(['graphql', 'query', '--document', '{}', '--variables', '{}', '--variables-file', 'vars.json'])).toThrow(/cannot be used/);
    expect(() => parseCli(['graphql', 'query', '--document', '{}', '--document', '{}'])).toThrow(/duplicate option/);
    expect(() => parseCli(['graphql', 'query', '{}'])).toThrow(/too many arguments/);
  });

  it('requires an agent for plugin installation and exposes the renamed help', () => {
    const rootHelp = parseCli(['--help']).helpText!;
    expect(rootHelp).toContain('aside plugin install --agent codex');
    expect(rootHelp).not.toContain('setup');
    expect(() => parseCli(['setup', 'install', '--agent', 'codex'])).toThrow(/unknown command 'setup'/);
    expect(() => parseCli(['plugin', 'install'])).toThrow(/required option '--agent/);
    expect(() => parseCli(['plugin', 'remove'])).toThrow(/required option '--agent/);
    for (const agent of ['codex', 'claude']) {
      expect(parseCli(['plugin', 'install', '--agent', agent])).toMatchObject({ command: 'plugin', operation: 'install' });
    }
    expect(parseCli(['plugin', 'status']).operation).toBe('status');
    expect(parseCli(['help', 'plugin', 'install']).helpText).toBe(parseCli(['plugin', 'install', '--help']).helpText);
  });

  it.each(['install', 'remove', 'status'])('selects the legacy plugin for %s only when requested', operation => {
    const args = ['plugin', operation, ...(operation === 'status' ? [] : ['--agent', 'codex'])];
    expect(parseCli(args).has('--legacy')).toBe(false);
    expect(parseCli([...args, '--legacy']).has('--legacy')).toBe(true);
    expect(parseCli([...args, '--help']).helpText).toContain('--legacy');
    expect(() => parseCli([...args, '--legacy', '--legacy'])).toThrow(/duplicate option/);
  });

  it('exposes registry commands under instance with repeatable paths', () => {
    for (const operation of ['add', 'forget']) {
      const parsed = parseCli(['instance', operation, '--dir=/one', '--dir', '/two', '--json']);
      expect(parsed).toMatchObject({ command: 'instance', operation });
      expect(parsed.all('--dir')).toEqual(['/one', '/two']);
      expect(parsed.has('--json')).toBe(true);
      expect(() => parseCli(['daemon', operation])).toThrow(/unknown command/);
    }
    expect(parseCli(['instance', 'list']).operation).toBe('list');
    expect(() => parseCli(['instance', 'list', '--dir=/one'])).toThrow(/unknown option/);
    expect(() => parseCli(['instance', 'list', '/one'])).toThrow(/too many arguments/);
    const help = parseCli(['instance', '--help']).helpText!;
    expect(help).toContain('never start the daemon');
    expect(parseCli(['help', 'instance', 'list']).helpText).toBe(parseCli(['instance', 'list', '--help']).helpText);
    const daemonHelp = parseCli(['daemon', '--help']).helpText!;
    expect(daemonHelp).not.toContain('add [options]');
    expect(daemonHelp).not.toContain('forget [options]');
  });

  it('places validation under instance and exposes URL output without serve', () => {
    expect(parseCli(['instance', 'validate', '--dir=/one'])).toMatchObject({ command: 'instance', operation: 'validate' });
    expect(parseCli(['instance', 'validate']).get('--dir')).toBeUndefined();
    expect(parseCli(['help', 'instance', 'validate']).helpText).toBe(parseCli(['instance', 'validate', '--help']).helpText);
    expect(parseCli(['show', '--url', '--dir=/one']).has('--url')).toBe(true);
    for (const command of ['serve', 'validate']) {
      expect(() => parseCli([command])).toThrow(/unknown command/);
      expect(parseCli(['--help']).helpText).not.toContain(`${command} [options]`);
    }
  });

  it('explains daemon start outcomes and build replacement in nested help', () => {
    const help = parseCli(['daemon', 'start', '--help']).helpText!;
    expect(parseCli(['help', 'daemon', 'start']).helpText).toBe(help);
    expect(help).toContain('Starts a new daemon when none is running');
    expect(help).toContain('later embedded build timestamp');
    expect(help).toContain('Rebuilding the same source later counts as a newer build');
    expect(help).toContain('An equal or older build reuses the daemon');
    expect(help).toContain('started, replaced (with the previous PID), or reused');
  });

  it.each(['start', 'install', 'run'])('rejects obsolete daemon lifecycle controls for %s', operation => {
    for (const args of [['--dir', '/one'], ['--all'], ['--long-running']]) {
      expect(() => parseCli(['daemon', operation, ...args])).toThrow(/unknown option/);
    }
    const help = parseCli(['daemon', operation, '--help']).helpText!;
    expect(help).not.toContain('--dir');
    expect(help).not.toContain('--all');
    expect(help).not.toContain('--long-running');
  });

  it('accepts both force-stop spellings and explains them in help', () => {
    for (const option of ['-f', '--force']) {
      expect(parseCli(['daemon', 'stop', option]).has('--force')).toBe(true);
    }
    expect(() => parseCli(['daemon', 'stop', '-f', '--force'])).toThrow(/duplicate option/);
    expect(() => parseCli(['daemon', 'start', '-f'])).toThrow(/unknown option/);
    const help = parseCli(['daemon', 'stop', '--help']).helpText!;
    expect(help).toContain('-f, --force');
    expect(help).toContain('Without --force, refuses to stop');
    expect(help).toContain('With --force, shuts down gracefully');
  });

  it.each([
    ['instance', 'init'], ['artifact', 'create'], ['artifact', 'update'],
    ['instance', 'add'], ['instance', 'forget'], ['plugin', 'install'], ['plugin', 'remove'],
  ])('validates required options for %j and lets help bypass them', (...args) => {
    expect(() => parseCli(args)).toThrow(/required option/);
    expect(parseCli([...args, '--help']).helpText).toContain('Usage: aside');
  });

  it('keeps repeatable filters and attachment values in order', () => {
    const query = parseCli(['artifact', 'query', '--id=a', '--id', 'b', '--project=p', '--project=q', '--json']);
    expect(query).toMatchObject({ command: 'artifact', operation: 'query' });
    expect(query.all('--id')).toEqual(['a', 'b']);
    expect(query.all('--project')).toEqual(['p', 'q']);
    expect(query.has('--json')).toBe(true);
    const update = parseCli(['artifact', 'update', '--id=a', '--file=first=one.pdf', '--file', 'two.pdf', '--remove-file=-old', '--body=']);
    expect(update.all('--file')).toEqual(['first=one.pdf', 'two.pdf']);
    expect(update.get('--body')).toBe('');
    expect(update.all('--remove-file')).toEqual(['-old']);
  });

  it('preserves whitespace, equals signs, and dash-leading body values', () => {
    const parsed = parseCli(['instance', 'init', '--dir', 'a directory', '--name= Work ', '--description=Work log', '--body=- first\nsecond=a=b']);
    expect(parsed).toMatchObject({ command: 'instance', operation: 'init' });
    expect(parsed.get('--dir')).toBe('a directory');
    expect(parsed.get('--name')).toBe('Work');
    expect(parsed.get('--body')).toBe('- first\nsecond=a=b');
    expect(parseCli(['artifact', 'update', '--id=a', '--body', '--draft']).get('--body')).toBe('--draft');
  });

  it('exposes instance initialization through nested help and rejects root init', () => {
    const help = parseCli(['instance', 'init', '--help']).helpText!;
    expect(parseCli(['help', 'instance', 'init']).helpText).toBe(help);
    expect(help).toContain('Usage: aside instance init [options]');
    expect(help).toContain('--tutorial');
    expect(help).toContain('without registering the instance or starting the daemon');
    expect(parseCli(['instance', '--help']).helpText).toContain('init [options]');
    expect(() => parseCli(['init'])).toThrow(/unknown command 'init'/);
  });

  it('honors the option terminator and never splits positional values at equals signs', () => {
    const target = 'aside://work/artifact/2026-10-05-plan/diagram=a.svg';
    expect(parseCli(['show', '--json', '--', target]).get('target')).toBe(target);
    const literal = parseCli(['show', '--', '--json']);
    expect(literal.get('target')).toBe('--json');
    expect(literal.has('--json')).toBe(false);
    expect(literal.has('--help')).toBe(false);
  });

  it.each([
    ['instance', 'validate', '--dir=a', '--dir=b'], ['artifact', 'update', '--id=a', '--id=b'],
    ['plugin', 'install', '--agent=claude', '--print', '--print'],
  ])('rejects accidental duplicate nonrepeatable options in %j', (...args) => {
    expect(() => parseCli(args)).toThrow(/duplicate option/);
  });

  it.each([
    ['artifact', 'create', '--name=Plan', '--description=Plan', '--body=', '--body-file=a.md'],
  ])('rejects conflicting options in either order for %j', (...args) => {
    expect(() => parseCli(args)).toThrow(/cannot be used with/);
  });

  it.each([
    ['artifact', 'query', '--limit=0'], ['artifact', 'query', '--limit=101'],
    ['artifact', 'query', '--offset=-1'], ['artifact', 'query', '--offset=1.5'],
    ['artifact', 'query', '--offset=9007199254740992'], ['artifact', 'query', '--from=2026-02-30'],
    ['artifact', 'query', '--detail=all'], ['plugin', 'install', '--agent=cursor'],
    ['instance', 'init', '--dir=a', '--name= ', '--description=Plan'], ['show', '--app-dir='],
  ])('rejects invalid values in %j before executing', (...args) => {
    expect(() => parseCli(args)).toThrow(/invalid/);
  });

  it('validates date ranges before resolving an instance', () => {
    expect(() => parseCli(['artifact', 'query', '--dir=/missing', '--from=2026-10-06', '--to=2026-10-05'])).toThrow(/--from must not be after --to/);
  });

  it('preserves legacy launchd startup arguments only with its environment marker', () => {
    vi.stubEnv('ASIDE_JOB_BUILT_AT', undefined);
    const args = ['daemon', 'start', '--foreground', '/one', '/two'];
    expect(() => parseCli(args)).toThrow(/too many arguments/);
    vi.stubEnv('ASIDE_JOB_BUILT_AT', '1234');
    const saved = parseCli(args);
    expect(saved.all('--dir')).toBeUndefined();
    expect(saved.has('--foreground')).toBe(true);
    expect(() => parseCli(['daemon', 'start', '--foreground', 'relative'])).toThrow(/too many arguments/);
  });

  it('accepts valid pagination boundaries and leap days', () => {
    const query = parseCli(['artifact', 'query', '--offset=0', '--limit=100', '--from=2024-02-29']);
    expect(query.get('--offset')).toBe('0');
    expect(query.get('--limit')).toBe('100');
    expect(query.get('--from')).toBe('2024-02-29');
  });

  it('suggests close option and command spellings with command-specific help', () => {
    expect(() => parseCli(['instance', 'validate', '--dri', 'a'])).toThrow(/Did you mean --dir/);
    expect(() => parseCli(['artfact'])).toThrow(/Did you mean artifact/);
    expect(() => parseCli(['daemon', 'stats'])).toThrow(/Did you mean status/);
    expect(() => parseCli(['artifact', 'query', '--unknown'])).toThrow(/Usage: aside artifact query/);
  });

  it.each([
    ['plugin', 'remove', '--agent=claude', '--force'], ['mcp', '--json'],
    ['instance', 'validate', 'extra'], ['show', 'one', 'two'], ['daemon', 'start', '--all=true'],
  ])('rejects unsupported arguments in %j', (...args) => {
    expect(() => parseCli(args)).toThrow(/unknown option|too many arguments/);
  });
});

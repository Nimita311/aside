import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { init } from '../src/commands/init.js';
import { runValidate } from '../src/commands/validate.js';
import { runShow } from '../src/commands/show.js';
import { runMcp } from '../src/commands/mcp.js';

const bundle = join(__dirname, '..', 'dist', 'main.js');
const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

describe('CLI output', () => {
  let root: string;
  let instance: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aside-cli-output-'));
    instance = join(root, 'instance');
    init(instance, { name: 'Test', description: 'CLI output checks' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
    else delete (process.stdout as { isTTY?: boolean }).isTTY;
    rmSync(root, { recursive: true, force: true });
  });

  it('prints help without validating a path or starting a server', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runValidate(['--help'])).toBe(0);
    await runShow(['--help']);
    await runMcp(['--help']);
    const help = log.mock.calls.map(([line]) => line);
    expect(help).toHaveLength(3);
    for (const [index, command] of ['instance validate', 'show', 'mcp'].entries()) {
      expect(help[index]).toContain(`Usage: aside ${command} [options]`);
      expect(help[index]).toContain('--dir <path>');
      expect(help[index]).toContain('-h, --help');
    }
  });

  it('rejects unrecognized, duplicate, and extra arguments before acting', async () => {
    expect(() => runValidate(['--dir', instance, '--unknown'])).toThrow(/unknown option/);
    expect(() => runValidate(['--dir', instance, 'extra'])).toThrow(/too many arguments/);
    expect(runValidate(['--help', '-h'])).toBe(0);
    await expect(runShow(['--dir', instance, 'extra', 'another'])).rejects.toThrow(/too many arguments/);
    await expect(runShow(['--app-dir', root, '--app-dir', root])).rejects.toThrow(/duplicate option/);
    await expect(runShow(['--unknown'])).rejects.toThrow(/unknown option/);
    await expect(runMcp([instance])).rejects.toThrow(/--dir <path>/);
    await expect(runMcp(['--dir'])).rejects.toThrow(/argument missing/);
    expect(() => runValidate(['--dir', ''])).toThrow(/requires a nonempty value/);
    await expect(runShow(['--dir', ''])).rejects.toThrow(/requires a nonempty value/);
    await expect(runShow(['--app-dir', ''])).rejects.toThrow(/--app-dir requires a nonempty value/);
  });

  it('prints every validation diagnostic', () => {
    const projectDir = join(instance, 'projects', '2026');
    mkdirSync(projectDir, { recursive: true });
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(projectDir, `2026-10-02-broken-${String(i).padStart(2, '0')}.md`), '---\nname: Broken\n---\n');
    }
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runValidate(['--dir', instance])).toBe(1);
    const output = log.mock.calls.map(([line]) => line).join('\n');
    expect(output).toContain("2026-10-02-broken-29.md: missing 'created'");
    expect(output).not.toMatch(/and \d+ more/);
  });

  it('colors terminal validation output and respects NO_COLOR', () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.stubEnv('NO_COLOR', undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    runValidate(['--dir', instance]);
    expect(log.mock.calls.map(([line]) => line).join('\n')).toContain('\x1b[');
    log.mockClear();
    vi.stubEnv('NO_COLOR', '');
    runValidate(['--dir', instance]);
    expect(log.mock.calls.map(([line]) => line).join('\n')).not.toContain('\x1b[');
  });

  describe.skipIf(!existsSync(bundle))('bundled output contract', () => {
    function run(args: string[]) {
      return spawnSync(process.execPath, [bundle, ...args], { cwd: root, env: { ...process.env, ASIDE_DAEMON_HOME: join(root, 'daemon') }, encoding: 'utf8', timeout: 5000 });
    }

    it.each(['show', 'mcp', 'artifact', 'daemon', 'instance', 'plugin'])('supports %s --help with plain stdout', (command) => {
      const result = run([command, '--help']);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).not.toContain('\x1b[');
    });

    it.each(['plugin', 'artifact', 'daemon', 'instance'])('bare %s shows help without changing state', command => {
      const result = run([command]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage:');
      expect(existsSync(join(root, 'daemon'))).toBe(false);
    });

    it.each([
      ['plugin', 'install', '--agent', 'codex'], ['plugin', 'remove'], ['plugin', 'status'],
      ['artifact', 'create'], ['artifact', 'update'], ['artifact', 'query'],
      ['daemon', 'start'], ['daemon', 'install'],
      ['instance', 'init'], ['instance', 'add'], ['instance', 'forget'], ['instance', 'list'], ['instance', 'validate'], ['daemon', 'status'], ['daemon', 'stop'], ['daemon', 'uninstall'],
    ])('operation help %j never changes state or requires data', (...args) => {
      const result = run([...args, '--help']);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage:');
      expect(existsSync(join(root, 'daemon'))).toBe(false);
    });

    it('creates and validates a directory with spaces through named options and equals syntax', () => {
      const dir = join(root, 'new instance');
      const result = run(['instance', 'init', `--dir=${dir}`, '--name=Work', '--description', 'Work log', '--body=-instructions']);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(existsSync(join(dir, 'aside.md'))).toBe(true);
      expect(run(['instance', 'validate', `--dir=${dir}`]).status).toBe(0);
      const fromCwd = spawnSync(process.execPath, [bundle, 'instance', 'validate'], { cwd: dir, encoding: 'utf8' });
      expect(fromCwd.status).toBe(0);
      expect(fromCwd.stderr).toBe('');
    });

    it('advertises the supported MCP directory option', () => {
      const result = run(['--help']);
      expect(result.stdout).toContain('mcp [options]');
      expect(run(['mcp', '--help']).stdout).toContain('--dir <path>');
      expect(result.stdout).not.toContain('mcp [path]');
      expect(result.stdout).not.toContain('\x1b[');
    });

    it.each([
      ['instance', 'init', '--dir', 'new', 'extra', '--name', 'Test', '--description', 'Review'],
      ['instance', 'init', '--dir', 'new', '--name', 'Test', '--name', 'Other', '--description', 'Review'],
      ['instance', 'init', '--dir', 'new', '--name', 'Test', '--description', 'Review', '--tutorial', '--tutorial'],
      ['instance', 'validate', 'instance', '--unknown'],
      ['show', 'instance', 'extra'],
      ['mcp', 'instance'],
      ['mcp', '--unknown'],
      ['mcp', '--graphql'],
      ['mcp', '--dir', 'instance', '--dir', 'instance'],
      ['artifact', 'create', '--dir', '', '--name', 'Plan', '--description', 'Current plan'],
      ['instance', 'validate', ''],
      ['show', '--app-dir', ''],
      ['plugin', 'cursor'],
      ['plugin', 'install', '--agent', 'claude', '--nope'],
      ['show', 'https://example.com'],
      ['show', '#action/a', '#action/b'],
      ['show', '--dir', 'instance'],
      ['daemon', 'start', 'instance'],
      ['daemon', 'start', '--foreground', '/nonexistent'],
      ['daemon', 'start', '--dir', 'instance', '--all'],
      ['daemon', 'start', '--dir', ''],
      ['daemon', 'start', '--all=true'],
      ['daemon', 'start', '--all', '--all'],
      ['instance', 'add'],
      ['instance', 'forget'],
      ['artifact', 'update', 'id'],
      ['artifact', 'update', '--id', 'id', '--id', 'other'],
      ['instance', 'init', '--name', 'Work', '--description', 'Work log'],
      ['instance', 'init', '--dir', 'new', '--name', 'Work', '--description', 'Work log', '--tutorial=true'],
      ['daemon', 'nope'],
      ['unknown'],
    ])('reports invalid invocation %j only on stderr', (...args) => {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Error:');
      expect(existsSync(join(root, 'new'))).toBe(false);
    });

    it('keeps piped validation plain and signals a failing check', () => {
      const valid = run(['instance', 'validate', '--dir', instance]);
      expect(valid.status).toBe(0);
      expect(valid.stdout).toContain('[OK]');
      expect(valid.stdout).not.toContain('\x1b[');
      const invalid = run(['instance', 'validate', '--dir', root]);
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toContain('aside.md not found');
      expect(invalid.stdout).toContain('Aside validation blocked');
      expect(invalid.stdout).toContain('Data checks were not run.');
      expect(invalid.stdout).toContain('aside instance validate --dir <instance-directory>');
      expect(invalid.stdout).not.toContain('[OK]');
      expect(invalid.stdout).not.toContain('\x1b[');
      expect(invalid.stderr).toBe('');
    });

    it.each([false, true])('prints a plugin install failure once with recovery commands (json=%s)', json => {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'aside'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const diagnostic = `Error: failed to load marketplace(s):\n- \`aside-marketplace\` at ${join(root, 'old agent')}: marketplace root does not contain a supported manifest`;
      writeFileSync(join(bin, 'codex'), `#!/bin/sh\n/bin/cat >&2 <<'DIAGNOSTIC'\n${diagnostic}\nDIAGNOSTIC\nexit 1\n`, { mode: 0o755 });
      const result = spawnSync(process.execPath, [bundle, 'plugin', 'install', '--agent', 'codex', ...(json ? ['--json'] : [])], {
        cwd: root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, encoding: 'utf8', timeout: 5000,
      });
      expect(result.status).toBe(1);
      const fixes = [`${join(bin, 'codex')} plugin marketplace remove aside-marketplace`, 'aside plugin install --agent codex'];
      if (json) {
        expect(result.stderr).toBe('');
        const report = JSON.parse(result.stdout);
        expect(report.ok).toBe(false);
        expect(report.checks[0].fixes).toEqual(fixes);
        expect(report.checks[0].problems).toEqual([`${join(bin, 'codex')} plugin marketplace list --json failed:\n${diagnostic}`]);
      } else {
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe(`Error: ${join(bin, 'codex')} plugin marketplace list --json failed:\n${diagnostic}\n${fixes.map(fix => `Fix: ${fix}`).join('\n')}\n`);
      }
    });

    it('drains every validation diagnostic before exiting when a pipe consumer is slow', async () => {
      const projectDir = join(instance, 'projects', '2026');
      mkdirSync(projectDir, { recursive: true });
      for (let i = 0; i < 2000; i++) {
        writeFileSync(join(projectDir, `2026-10-02-broken-${String(i).padStart(4, '0')}.md`), '---\nname: Broken\n---\n');
      }
      const expected = run(['instance', 'validate', '--dir', instance]);
      const child = spawn(process.execPath, [bundle, 'instance', 'validate', '--dir', instance], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = once(child, 'exit');
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      let poll: ReturnType<typeof setInterval> | undefined;
      const buffered = new Promise<void>((resolve) => {
        poll = setInterval(() => {
          if (child.stdout.readableLength >= child.stdout.readableHighWaterMark) resolve();
        }, 5);
      });
      const timeout = setTimeout(() => child.kill(), 5000);
      try {
        // Keep stdout paused until its buffer fills, then give the producer
        // time to encounter backpressure before beginning to consume it.
        await Promise.race([exited, buffered]);
        clearInterval(poll);
        await new Promise((resolve) => setTimeout(resolve, 100));
        let stdout = '';
        for await (const chunk of child.stdout) stdout += chunk;
        const [code, signal] = await exited;
        expect(code).toBe(1);
        expect(signal).toBeNull();
        expect(stderr).toBe('');
        expect(stdout.length).toBe(expected.stdout.length);
        expect(stdout === expected.stdout).toBe(true);
        expect(stdout).toContain("2026-10-02-broken-1999.md: missing 'created'");
        expect(stdout).toContain('[ERROR]');
        expect(stdout).not.toContain('\x1b[');
      } finally {
        clearInterval(poll);
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    }, 10000);
  });
});

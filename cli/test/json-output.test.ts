import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { init } from '../src/commands/init.js';
import { runArtifact } from '../src/commands/artifact.js';
import { runPlugin } from '../src/commands/plugin.js';
import { formatDaemonStatus } from '../src/commands/daemon-status.js';
import { daemonPaths } from '../src/daemon/paths.js';

describe('CLI JSON output', () => {
  let root: string;
  let work: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync('/tmp/aside-json-'));
    work = join(root, 'work');
    init(work, { name: 'Work', description: 'JSON checks' });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function run(args: string[]) {
    const result = spawnSync(process.execPath, [join(__dirname, '../dist/main.js'), ...args], {
      cwd: root, env: { ...process.env, ASIDE_DAEMON_HOME: join(root, 'state'), ASIDE_CAL_BIN: '/nonexistent' }, encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout);
    expect(output.schema_version).toBe(1);
    expect(output.ok).toBe(result.status === 0);
    expect(result.stdout).not.toContain('\x1b[');
    return output;
  }
  it('returns typed validation checks and complete failing diagnostics', () => {
    const good = run(['instance', 'validate', '--dir', work, '--json']);
    expect(good.command).toBe('instance validate');
    expect(good.data.dataChecksRun).toBe(true);
    expect(good.data.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
    const bad = run(['instance', 'validate', '--dir', root, '--json']);
    expect(bad.ok).toBe(false);
    expect(bad.data.dataChecksRun).toBe(false);
    expect(bad.data.checks).toHaveLength(1);
    expect(bad.checks).toHaveLength(1);
    expect(bad.checks[0].passed).toBe(false);
    expect(bad.checks.some((check: { problems?: string[] }) => check.problems?.some(problem => problem.includes('aside.md not found')))).toBe(true);
  });
  it('returns created files without mixing a human receipt into JSON', () => {
    const result = run(['instance', 'init', '--dir', 'new', '--name', 'New', '--description', 'New instance', '--json']);
    expect(result.command).toBe('instance init');
    const data = result.data;
    expect(data.dataDir).toBe(join(root, 'new'));
    expect(data.created).toEqual(['aside.md']);
  });
  it('returns one JSON document for stopped status and registry edits', () => {
    expect(run(['daemon', 'status', '--json']).data.daemon).toBeNull();
    expect(run(['instance', 'add', '--dir', work, '--json']).data.instances[0].path).toBe(work);
    const listed = run(['instance', 'list', '--json']);
    expect(listed.command).toBe('instance list');
    expect(listed.data.instances[0].path).toBe(work);
    expect(run(['instance', 'forget', '--dir', work, '--json']).data.instances).toEqual([]);
    expect(run(['daemon', 'stop', '--json']).data.stopped).toBe(true);
  });
  it.each([
    ['instance', 'validate', '--wat'], ['artifact', 'query', '--limit', '0'], ['show', 'bad'],
    ['daemon', 'nope'], ['plugin', 'install'], ['unknown'], ['mcp'],
    ['artifact', 'query', '--search', '--', '--limit=0'],
    ['instance', 'validate', '--unknown', '--body'],
  ])('returns a parseable error for %j', args => {
    const result = run([...args, '--json']);
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ severity: 'error', code: 'command_failed' });
  });
  it.each([
    ['show', '--', '--json'], ['show', '--', '--json', 'extra'],
    ['instance', 'init', '--body', '--json'], ['artifact', 'update', '--body', '--json'],
    ['artifact', 'query', '--json=true'],
  ])('keeps literal JSON flag values in human error output for %j', (...args) => {
    const result = spawnSync(process.execPath, [join(__dirname, '../dist/main.js'), ...args], { cwd: root, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Error:');
  });

  it('leaves per-instance manifest problems to validation in status JSON', () => {
    run(['instance', 'add', '--dir', work, '--json']);
    writeFileSync(join(work, 'aside.md'), '---\nid: INVALID\nname: Work\n---\n');
    const result = run(['daemon', 'status', '--json']);
    expect(result.ok).toBe(true);
    expect(result.data.instances[0].name).toBe('Work');
    expect(result.checks.filter((check: { code: string }) => check.code.startsWith('instance_'))).toEqual([]);
    expect(run(['instance', 'validate', '--dir', work, '--json']).ok).toBe(false);
  });
  it('fails listing and status once per catalogue ID clash with all conflicting paths', () => {
    const second = join(root, 'second');
    init(second, { name: 'Work', description: 'Another instance' });
    run(['instance', 'add', '--dir', work, '--dir', second, '--json']);
    for (const command of [['instance', 'list'], ['daemon', 'status']]) {
      const report = run([...command, '--json']);
      expect(report.ok).toBe(false);
      const conflicts = report.checks.filter((check: { code: string }) => check.code.startsWith('instance_'));
      expect(conflicts).toEqual([expect.objectContaining({ code: 'instance_id_conflict', passed: false })]);
      expect(conflicts[0].problems[0]).toContain(work);
      expect(conflicts[0].problems[0]).toContain(second);
    }
  });
  it('preserves native MCP artifact content and parse issues without parsing its text', async () => {
    const text = '1 of 1\noffset: 0\nlimit: 20\nnext_offset: null\n\n#artifact/2026-10-05-brief — Brief';
    const output = JSON.parse(await runArtifact(['query', '--json'], work, async () => ({ text, issues: [] })));
    expect(output.data).toEqual({ content: [{ type: 'text', text }], issues: [] });
    expect(await runArtifact(['query'], work, async () => ({ text }))).toBe(text);
  });
  it('keeps plugin checks and information structured, including partial inspection failure', async () => {
    const output: string[] = [];
    await runPlugin(['status', '--json'], { root, home: root, node: process.execPath, script: '/test/main.js', find: () => null,
      findAside: () => null, runner: async () => { throw new Error('Should not call an agent'); }, out: text => output.push(text) });
    expect(output).toHaveLength(1);
    const result = JSON.parse(output[0]);
    expect(result.command).toBe('plugin status');
    expect(result.ok).toBe(false);
    expect(result.data.checkout).toBe(root);
    expect(result.checks.some((check: { code: string }) => check.code === 'codex_cli')).toBe(true);
  });
  it('annotates separate instances with the same name and preserves per-instance session counts', () => {
    const second = join(root, 'second');
    init(second, { name: 'Work', description: 'Another instance' });
    writeFileSync(join(second, 'aside.md'), '---\nid: work-home\nname: Work\n---\n');
    const snapshot = { paths: daemonPaths({ ASIDE_DAEMON_HOME: root }), unavailable: false, known: [work, second], job: null, jobFileExists: false,
      running: { pid: 123, build: { version: '0.1.0', builtAt: 0 },
        connections: 2, tabs: 0, known: [work, second], loaded: [work, second], sessions: { [work]: 1, [second]: 0 } } };
    const human = formatDaemonStatus(snapshot).output;
    expect(human).toContain(`Work (loaded, 1 active session)\n  ${work}`);
    expect(human).toContain(`Work (loaded)\n  ${second}`);
    const json = JSON.parse(formatDaemonStatus(snapshot, true).output);
    expect(json.data.instances.map((instance: { sessions: number }) => instance.sessions)).toEqual([1, 0]);
  });
});

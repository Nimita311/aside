import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSystemInstallation } from '../src/graphql/system-installation.js';
import { runPlugin, type PluginContext, type Runner } from '../src/commands/plugin.js';

describe('GraphQL installation status collector', () => {
  let home: string;
  const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
  const runner = vi.fn<Runner>();
  const out = vi.fn();
  const context = (): PluginContext => ({home, cwd: home, root, node: '/usr/bin/node',
    script: join(root, 'cli/dist/main.js'), codexHome: join(home, '.codex'),
    find: name => name, findAside: () => null, runner, out});

  beforeEach(() => {
    home = mkdtempSync('/private/tmp/aside-system-installation-');
    runner.mockReset(); out.mockReset();
    runner.mockImplementation(async (command, args) => ({code: 0, stderr: '', stdout: JSON.stringify(command === 'claude'
      ? [] : args[1] === 'marketplace' ? {marketplaces: []} : {installed: []})}));
  });
  afterEach(() => rmSync(home, {recursive: true, force: true}));

  it('consolidates the existing CLI status information and checks without publishing or changing registration', async () => {
    await runPlugin(['status', '--json'], context());
    const cli = JSON.parse(out.mock.calls[0][0]);
    out.mockClear(); runner.mockClear();
    const result = await collectSystemInstallation({context: context()});
    expect(result.checkout).toBe(cli.data.checkout);
    expect(result.information).toEqual(cli.data.information.flatMap((section: {name: string; fields?: Record<string, unknown>}) =>
      Object.entries(section.fields ?? {}).map(([name, value]) => ({group: section.name, name, value: value == null ? null : String(value)}))));
    expect(result.checks).toEqual(cli.checks.map((check: {problems?: string[]; fixes?: string[]}) =>
      ({...check, problems: check.problems ?? [], fixes: check.fixes ?? []})));
    expect(result.agents).toEqual([
      {name: 'claude', path: 'claude', claude: cli.data.agents.claude, codex: null},
      {name: 'codex', path: 'codex', claude: null, codex: cli.data.agents.codex},
    ]);
    expect(runner.mock.calls.map(([command, args]) => [command, ...args])).toEqual([
      ['claude', 'plugin', 'marketplace', 'list', '--json'],
      ['claude', 'plugin', 'list', '--json'],
      ['codex', 'plugin', 'marketplace', 'list', '--json'],
      ['codex', 'plugin', 'list', '--json'],
    ]);
    expect(out).not.toHaveBeenCalled();
    expect(readdirSync(home)).toEqual([]);
  });

  it('retains working-agent state and build diagnostics when another agent cannot be inspected', async () => {
    const original = runner.getMockImplementation()!;
    runner.mockImplementation((command, args, options) => {
      if (command === 'claude') throw new Error('registration unreadable');
      return original(command, args, options);
    });
    const result = await collectSystemInstallation({context: context()});
    expect(result.information).toContainEqual({group: 'CLI', name: 'Checkout', value: root});
    expect(result.agents.find(agent => agent.name === 'claude')?.claude).toBeNull();
    expect(result.agents.find(agent => agent.name === 'codex')?.codex).toMatchObject({installed: false});
    expect(result.checks).toContainEqual(expect.objectContaining({passed: false, group: 'Claude Code',
      problems: [expect.stringContaining('registration unreadable')]}));
  });

  it('inspects project-scoped plugin state in the caller session workspace', async () => {
    const workspace = join(home, 'session-workspace'); mkdirSync(workspace);
    const original = runner.getMockImplementation()!;
    runner.mockImplementation((command, args, input) => {
      if (command === 'claude' && args[1] === 'list') return Promise.resolve({code: 0, stderr: '', stdout: JSON.stringify([
        {id: 'aside@aside-marketplace', scope: 'project', projectPath: input?.cwd, enabled: true},
      ])});
      return original(command, args, input);
    });
    const result = await collectSystemInstallation({context: context(), cwd: workspace});
    expect(runner.mock.calls.every(([, , input]) => input?.cwd === workspace)).toBe(true);
    expect(result.agents.find(agent => agent.name === 'claude')?.claude?.installations).toEqual([
      {id: 'aside@aside-marketplace', scope: 'project', projectPath: workspace, enabled: true},
    ]);
    expect(context().cwd).toBe(home);
  });

  const installClaudeFrom = (cache: string) => {
    const original = runner.getMockImplementation()!;
    runner.mockImplementation((command, args, input) => {
      if (command === 'claude' && args[1] === 'list') return Promise.resolve({code: 0, stderr: '', stdout: JSON.stringify([
        {id: 'aside@aside-marketplace', scope: 'user', installPath: cache, enabled: true},
      ])});
      return original(command, args, input);
    });
  };

  it('preserves the CLI file comparison result for a normal installed package', async () => {
    const cache = join(home, 'cache'); cpSync(join(root, 'agent/graphql'), cache, {recursive: true});
    installClaudeFrom(cache);
    await runPlugin(['status', '--json'], context());
    const cli = JSON.parse(out.mock.calls[0][0]);
    const result = await collectSystemInstallation({context: context()});
    expect(result.agents.find(agent => agent.name === 'claude')?.claude).toEqual(cli.data.agents.claude);
    expect(result.agents.find(agent => agent.name === 'claude')?.claude?.needsRefresh).toBe(false);
  });

  it.each(['symbolic-link cycle', 'byte limit', 'file count limit', 'directory depth limit'])(
    'retains partial diagnostics when a cached plugin has a %s', async problem => {
      const cache = join(home, 'cache'); mkdirSync(cache);
      if (problem === 'symbolic-link cycle') symlinkSync(cache, join(cache, 'loop'), 'dir');
      else if (problem === 'byte limit') {
        const file = join(cache, 'oversized'); const fd = openSync(file, 'w'); closeSync(fd); truncateSync(file, 9 * 1024 * 1024);
      } else if (problem === 'file count limit') {
        for (let i = 0; i < 2_001; i++) writeFileSync(join(cache, String(i)), '');
      } else mkdirSync(join(cache, ...Array.from({length: 33}, () => 'deep')), {recursive: true});
      installClaudeFrom(cache);
      const started = Date.now();
      const result = await collectSystemInstallation({context: context()});
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result.checks).toContainEqual(expect.objectContaining({passed: false, group: 'Claude Code',
        problems: [expect.stringContaining(problem)]}));
      expect(result.agents.find(agent => agent.name === 'claude')?.claude).toBeNull();
      expect(result.agents.find(agent => agent.name === 'codex')?.codex).toMatchObject({installed: false});
    });

  it('returns timeout diagnostics rather than hanging on an unresponsive listing command', async () => {
    runner.mockImplementation(() => new Promise(() => {}));
    const result = await collectSystemInstallation({context: context(), timeoutMs: 10});
    expect(result.checks).toContainEqual(expect.objectContaining({passed: false,
      problems: [expect.stringContaining('timeout')]}));
    expect(runner).toHaveBeenCalledOnce();
    expect(out).not.toHaveBeenCalled();
  });

  it('checks the wall-clock deadline during synchronous file inspection', async () => {
    const cache = join(home, 'cache'); cpSync(join(root, 'agent/graphql'), cache, {recursive: true});
    installClaudeFrom(cache);
    let elapsed = 0;
    // Advancing the clock without yielding cannot fire AbortSignal.timeout.
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => elapsed += 10);
    try {
      const result = await collectSystemInstallation({context: context(), timeoutMs: 75});
      expect(result.checks).toContainEqual(expect.objectContaining({passed: false, group: 'Claude Code',
        problems: [expect.stringContaining('file inspection timed out')]}));
      expect(runner.mock.calls.every(([command]) => command === 'claude')).toBe(true);
    } finally { clock.mockRestore(); }
  });

  it('propagates caller cancellation while a listing command is pending', async () => {
    runner.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = collectSystemInstallation({context: context(), signal: controller.signal});
    controller.abort(new Error('request cancelled'));
    await expect(pending).rejects.toThrow('request cancelled');
    expect(runner).toHaveBeenCalledOnce();
  });

  it('does not inspect registration when already cancelled', async () => {
    const controller = new AbortController(); controller.abort(new Error('already cancelled'));
    await expect(collectSystemInstallation({context: context(), signal: controller.signal})).rejects.toThrow('already cancelled');
    expect(runner).not.toHaveBeenCalled();
  });
});

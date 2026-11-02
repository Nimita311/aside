import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkoutRoot, runPlugin, type RunResult, type PluginContext } from '../src/commands/plugin.js';

describe('committed agent packages', () => {
  it.each(['graphql', 'legacy'])('ships only the matching %s MCP configuration and skill', surface => {
    const directory = fileURLToPath(new URL(`../../agent/${surface}/`, import.meta.url));
    expect(readdirSync(directory).sort()).toEqual(['.claude-plugin', '.mcp.json', 'skills']);
    const manifest = JSON.parse(readFileSync(join(directory, '.claude-plugin/plugin.json'), 'utf8'));
    const marketplace = JSON.parse(readFileSync(join(directory, '.claude-plugin/marketplace.json'), 'utf8'));
    expect(manifest.skills).toEqual(['./skills/aside']);
    expect(manifest.mcpServers).toBe('./.mcp.json');
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: manifest.name, source: './' })]);
    expect(JSON.parse(readFileSync(join(directory, '.mcp.json'), 'utf8')).mcpServers.aside).toEqual({
      command: 'aside', args: ['mcp', ...(surface === 'legacy' ? ['--legacy'] : [])],
    });
    expect(readFileSync(join(directory, 'skills/aside/SKILL.md'), 'utf8')).toContain('name: aside');
    expect(existsSync(join(directory, 'skills/aside/references'))).toBe(surface === 'legacy');
  });
});

// A stand-in for the agents' CLIs: it answers the queries the plugin command makes from an
// in-memory state and applies the changes the plugin command asks for, recording every call.
// Nothing here touches the real claude or codex configuration.
interface Agents {
  marketplaces: Array<{ name: string; path: string }>;
  plugins: Array<{ id: string; scope: string; enabled?: boolean; projectPath?: string; errors?: unknown; installPath?: string; readFromFolder?: string; mcpServers?: Record<string, { command?: string; args?: string[] }> }>;
  // Codex marketplaces by name, and its installed plugins.
  codexMarketplaces: Record<string, string>;
  codexPlugins: Array<{ pluginId: string; enabled?: boolean }>;
}

describe('aside plugin', () => {
  let home: string;
  let root: string;
  let agents: Agents;
  let calls: string[][];
  let lines: string[];
  let found: Record<'claude' | 'codex', string | null>;
  let settingsFiles: Set<string>;
  let directories: Array<{ args: string[]; cwd?: string }>;
  let localRoots: Map<string, string>;
  let configDir: string | undefined;

  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });

  const pluginId = 'aside@aside-marketplace';
  const settingsFile = (scope: string, cwd = root) => scope === 'user' ? join(configDir ?? join(home, '.claude'), 'settings.json') : join(scope === 'local' ? localRoots.get(cwd) ?? cwd : cwd, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
  function setEnabled(scope: string, enabled: boolean, cwd = root, id = pluginId): void {
    const file = settingsFile(scope, cwd);
    mkdirSync(join(file, '..'), { recursive: true });
    const value = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    value.enabledPlugins = { ...value.enabledPlugins, [id]: enabled };
    writeFileSync(file, JSON.stringify(value)); settingsFiles.add(file);
  }
  const enabledAt = (scope: string, cwd = root) => existsSync(settingsFile(scope, cwd)) ? JSON.parse(readFileSync(settingsFile(scope, cwd), 'utf8')).enabledPlugins?.[pluginId] : undefined;

  function ctx(): PluginContext {
    return {
      home,
      cwd: root,
      claudeConfigDir: configDir,
      codexHome: join(home, '.codex'),
      root,
      node: '/usr/bin/node',
      script: join(root, 'cli', 'dist', 'main.js'),
      find: (name) => found[name],
      findAside: () => '/usr/local/bin/aside',
      out: (line) => lines.push(line),
      runner: async (command, args, options) => {
        calls.push([command, ...args]);
        directories.push({ args, cwd: options?.cwd });
        const key = args.join(' ');
        if (command === 'git') return { code: 1, stdout: '', stderr: 'not a git repository' };
        if (command === 'claude') {
          if (key === 'plugin marketplace list --json') return ok(JSON.stringify(agents.marketplaces.map((m) => ({ ...m, source: 'directory', installLocation: m.path }))));
          if (key === 'plugin list --json') return ok(JSON.stringify(agents.plugins));
          if (key.startsWith('plugin marketplace add ')) { agents.marketplaces.push({ name: 'aside-marketplace', path: args[3] }); return ok(); }
          if (key.startsWith('plugin marketplace remove ')) {
            agents.marketplaces = agents.marketplaces.filter((m) => m.name !== args[3]);
            agents.plugins = agents.plugins.filter(p => !p.id.endsWith(`@${args[3]}`));
            for (const file of settingsFiles) {
              const value = JSON.parse(readFileSync(file, 'utf8'));
              for (const id of Object.keys(value.enabledPlugins ?? {})) if (id.endsWith(`@${args[3]}`)) delete value.enabledPlugins[id];
              writeFileSync(file, JSON.stringify(value));
            }
            return ok();
          }
          if (key.startsWith('plugin install ')) {
            const scope = args[4], projectPath = scope === 'user' ? undefined : options?.cwd ?? root;
            agents.plugins.push({ id: args[2], scope, projectPath, enabled: true });
            setEnabled(scope, true, projectPath, args[2]); return ok();
          }
          if (args[1] === 'enable' || args[1] === 'disable') {
            const scope = args[4], cwd = options?.cwd ?? root, enabled = args[1] === 'enable';
            if (enabledAt(scope, cwd) === enabled) return { code: 1, stdout: '', stderr: 'already in goal state' };
            setEnabled(scope, enabled, cwd, args[2]);
            for (const plugin of agents.plugins) if (plugin.id === args[2] && plugin.scope === scope && (scope === 'user' || plugin.projectPath === cwd)) plugin.enabled = enabled;
            return ok();
          }
          if (key.startsWith('plugin uninstall ')) { agents.plugins = agents.plugins.filter((p) => !(p.id === args[2] && p.scope === args[4])); return ok(); }
        }
        if (command === 'codex') {
          if (key === 'plugin marketplace list --json') {
            return ok(JSON.stringify({ marketplaces: Object.entries(agents.codexMarketplaces).map(([name, path]) => ({ name, root: path })) }));
          }
          if (key === 'plugin list --json') return ok(JSON.stringify({ installed: agents.codexPlugins }));
          if (key.startsWith('plugin marketplace add ')) {
            const name = JSON.parse(readFileSync(join(args[3], '.claude-plugin', 'marketplace.json'), 'utf8')).name;
            agents.codexMarketplaces[name] = args[3];
            return ok();
          }
          if (key.startsWith('plugin marketplace remove ')) { delete agents.codexMarketplaces[args[3]]; return ok(); }
          if (key.startsWith('plugin add ')) {
            // Like Codex, install by copying the plugin folder into the cache.
            rmSync(cache(), { recursive: true, force: true });
            cpSync(agents.codexMarketplaces[args[2].split('@')[1]], cache(), { recursive: true });
            if (!agents.codexPlugins.some((p) => p.pluginId === args[2])) agents.codexPlugins.push({ pluginId: args[2], enabled: true });
            return ok();
          }
          if (key.startsWith('plugin remove ')) {
            agents.codexPlugins = agents.codexPlugins.filter((p) => p.pluginId !== args[2]);
            rmSync(cache(), { recursive: true, force: true });
            return ok();
          }
        }
        return { code: 1, stdout: '', stderr: `unexpected: ${command} ${key}` };
      },
    };
  }

  // Calls that changed something, as opposed to the status queries.
  const changes = () => calls.filter((c) => c[0] !== 'git' && !c.includes('--json')).map((c) => c.join(' '));

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'aside-plugin-home-'));
    root = mkdtempSync(join(tmpdir(), 'aside-plugin-root-'));
    for (const surface of ['graphql', 'legacy']) {
      const directory = join(root, 'agent', surface);
      mkdirSync(join(directory, '.claude-plugin'), { recursive: true });
      writeFileSync(join(directory, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'aside-marketplace', plugins: [{ name: 'aside', source: './' }] }));
      mkdirSync(join(directory, 'skills', 'aside'), { recursive: true });
      writeFileSync(join(directory, 'skills', 'aside', 'SKILL.md'), `---\nname: aside\n---\n${surface}\n`);
      writeFileSync(join(directory, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'aside', version: '0.1.0', skills: ['./skills/aside'], mcpServers: './.mcp.json' }));
      writeFileSync(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { aside: { command: 'aside', args: ['mcp', ...(surface === 'legacy' ? ['--legacy'] : [])] } } }));
    }
    writeFileSync(join(root, 'agent', 'spec.md'), 'Package-external developer documentation');
    mkdirSync(join(root, 'cli', 'dist'), { recursive: true });
    writeFileSync(join(root, 'cli', 'dist', 'main.js'), 'bundle v1');
    writeFileSync(join(root, 'cli', 'dist', 'aside-cal'), 'helper');
    mkdirSync(join(root, 'webapp', 'dist'), { recursive: true });
    writeFileSync(join(root, 'webapp', 'index.html'), '<html>');
    writeFileSync(join(root, 'webapp', 'style.css'), 'body{}');
    writeFileSync(join(root, 'webapp', 'dist', 'app.js'), 'app');
    agents = { marketplaces: [], plugins: [], codexMarketplaces: {}, codexPlugins: [] };
    calls = [];
    lines = [];
    found = { claude: 'claude', codex: 'codex' };
    settingsFiles = new Set(); directories = [];
    localRoots = new Map(); configDir = undefined;
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  const plugin = (legacy = false) => join(root, 'agent', legacy ? 'legacy' : 'graphql');
  const cache = () => join(home, '.codex', 'plugins', 'cache', 'aside-marketplace', 'aside', '0.1.0');
  const codexId = 'aside@aside-marketplace';

  it.each(['claude', 'codex'])('installs and removes only the legacy package for %s with --legacy', async agent => {
    await runPlugin(['install', '--agent', agent, '--legacy'], ctx());
    expect(changes()).toContain(`${agent} plugin marketplace add ${plugin(true)}`);
    if (agent === 'codex') {
      expect(JSON.parse(readFileSync(join(cache(), '.mcp.json'), 'utf8')).mcpServers.aside.args).toEqual(['mcp', '--legacy']);
      expect(readFileSync(join(cache(), 'skills/aside/SKILL.md'), 'utf8')).toContain('legacy');
      expect(existsSync(join(cache(), 'spec.md'))).toBe(false);
    }
    calls = [];
    await expect(runPlugin(['remove', '--agent', agent], ctx())).rejects.toThrow(/registered for legacy MCP.*--legacy.*No changes/s);
    expect(changes()).toEqual([]);
    await runPlugin(['remove', '--agent', agent, '--legacy'], ctx());
    expect(changes()).toContain(`${agent} plugin marketplace remove aside-marketplace`);
  });

  it.each(['claude', 'codex'])('switches %s between sibling packages without duplicate skills or --force', async agent => {
    await runPlugin(['install', '--agent', agent], ctx());
    calls = [];
    await runPlugin(['install', '--agent', agent, '--legacy'], ctx());
    expect(changes()).toContain(`${agent} plugin marketplace remove aside-marketplace`);
    expect(changes()).toContain(`${agent} plugin marketplace add ${plugin(true)}`);
    expect(agent === 'claude' ? agents.plugins : agents.codexPlugins).toHaveLength(1);
    calls = [];
    await runPlugin(['install', '--agent', agent], ctx());
    expect(changes()).toContain(`${agent} plugin marketplace add ${plugin()}`);
    expect(agent === 'claude' ? agents.plugins : agents.codexPlugins).toHaveLength(1);
    if (agent === 'codex') expect(JSON.parse(readFileSync(join(cache(), '.mcp.json'), 'utf8')).mcpServers.aside.args).toEqual(['mcp']);
  });

  it.each(['claude', 'codex'])('checks the registered package mode before removing from another checkout for %s', async agent => {
    for (const legacy of [false, true]) {
      const directory = join(home, 'other-checkout', 'agent', legacy ? 'legacy' : 'graphql');
      cpSync(plugin(legacy), directory, { recursive: true });
      if (agent === 'claude') {
        agents.marketplaces = [{ name: 'aside-marketplace', path: directory }];
        agents.plugins = [{ id: pluginId, scope: 'user', enabled: true }];
      } else {
        agents.codexMarketplaces['aside-marketplace'] = directory;
        agents.codexPlugins = [{ pluginId, enabled: true }];
      }
      calls = [];
      await expect(runPlugin(['remove', '--agent', agent, ...(!legacy ? ['--legacy'] : [])], ctx())).rejects.toThrow(/registered for .* MCP.*No changes/s);
      expect(changes()).toEqual([]);

      await runPlugin(['remove', '--agent', agent, ...(legacy ? ['--legacy'] : [])], ctx());
      expect(changes()).toEqual([agent === 'claude'
        ? `claude plugin uninstall ${pluginId} --scope user`
        : `codex plugin remove ${pluginId}`]);
      expect(agent === 'claude' ? agents.marketplaces[0].path : agents.codexMarketplaces['aside-marketplace']).toBe(directory);
    }
  });

  it.each(['claude', 'codex'])('does not infer an unavailable foreign package mode from its path for %s', async agent => {
    const directory = join(home, 'unavailable-checkout', 'agent', 'legacy');
    if (agent === 'claude') {
      agents.marketplaces = [{ name: 'aside-marketplace', path: directory }];
      agents.plugins = [{ id: pluginId, scope: 'user', enabled: true }];
    } else {
      agents.codexMarketplaces['aside-marketplace'] = directory;
      agents.codexPlugins = [{ pluginId, enabled: true }];
    }
    await runPlugin(['remove', '--agent', agent], ctx());
    expect(changes()).toEqual([agent === 'claude'
      ? `claude plugin uninstall ${pluginId} --scope user`
      : `codex plugin remove ${pluginId}`]);
    expect(agent === 'claude' ? agents.marketplaces[0].path : agents.codexMarketplaces['aside-marketplace']).toBe(directory);
  });

  it('preserves disabled Claude scope choices while changing to legacy', async () => {
    await runPlugin(['install', '--agent', 'claude'], ctx());
    agents.plugins[0].enabled = false;
    setEnabled('user', false);
    await runPlugin(['install', '--agent', 'claude', '--legacy'], ctx());
    expect(enabledAt('user')).toBe(false);
    expect(agents.plugins).toEqual([expect.objectContaining({ id: pluginId, enabled: false })]);
  });

  it('does not enable a disabled Codex plugin to change its surface', async () => {
    await runPlugin(['install', '--agent', 'codex'], ctx());
    agents.codexPlugins[0].enabled = false;
    calls = [];
    await expect(runPlugin(['install', '--agent', 'codex', '--legacy'], ctx())).rejects.toThrow(/disabled.*no changes/s);
    expect(changes()).toEqual([]);
    expect(agents.codexMarketplaces['aside-marketplace']).toBe(plugin());
  });

  it('keeps legacy selection in status recovery commands', async () => {
    await runPlugin(['status', '--legacy'], ctx());
    expect(lines.join('\n')).toContain('aside plugin install --agent claude --legacy');
    expect(lines.join('\n')).toContain('aside plugin install --agent codex --legacy');
    expect(lines.join('\n')).toContain(plugin(true));
    expect(changes()).toEqual([]);
  });

  it.each(['claude', 'codex'])('migrates the former agent package to GraphQL for %s', async agent => {
    if (agent === 'claude') agents.marketplaces = [{ name: 'aside-marketplace', path: join(root, 'agent') }];
    else agents.codexMarketplaces['aside-marketplace'] = join(root, 'agent');
    await runPlugin(['install', '--agent', agent], ctx());
    expect(changes()).toContain(`${agent} plugin marketplace remove aside-marketplace`);
    expect(changes()).toContain(`${agent} plugin marketplace add ${plugin()}`);
  });

  it.each(['claude', 'codex'])('removes the former GraphQL package and its unused marketplace for %s', async agent => {
    if (agent === 'claude') {
      agents.marketplaces = [{ name: 'aside-marketplace', path: join(root, 'agent') }];
      agents.plugins = [{ id: pluginId, scope: 'user', enabled: true }];
    } else {
      agents.codexMarketplaces['aside-marketplace'] = join(root, 'agent');
      agents.codexPlugins = [{ pluginId, enabled: true }];
    }
    await expect(runPlugin(['remove', '--agent', agent, '--legacy'], ctx())).rejects.toThrow(/registered for GraphQL MCP.*No changes/s);
    expect(changes()).toEqual([]);
    await runPlugin(['remove', '--agent', agent], ctx());
    expect(changes()).toEqual([agent === 'claude'
      ? `claude plugin uninstall ${pluginId} --scope user`
      : `codex plugin remove ${pluginId}`, `${agent} plugin marketplace remove aside-marketplace`]);
  });

  it('keeps the former Claude marketplace while another scope uses it', async () => {
    agents.marketplaces = [{ name: 'aside-marketplace', path: join(root, 'agent') }];
    agents.plugins = [{ id: pluginId, scope: 'user' }, { id: pluginId, scope: 'project' }];
    await runPlugin(['remove', '--agent', 'claude'], ctx());
    expect(changes()).toEqual([`claude plugin uninstall ${pluginId} --scope user`]);
    expect(agents.marketplaces).toHaveLength(1);
    expect(agents.plugins).toEqual([{ id: pluginId, scope: 'project' }]);
  });

  it.each(['claude', 'codex'])('keeps current and former marketplaces used by another plugin for %s', async agent => {
    const otherId = 'other@aside-marketplace';
    for (const directory of [plugin(), join(root, 'agent')]) {
      if (agent === 'claude') {
        agents.marketplaces = [{ name: 'aside-marketplace', path: directory }];
        agents.plugins = [{ id: pluginId, scope: 'user' }, { id: otherId, scope: 'user', enabled: false }];
      } else {
        agents.codexMarketplaces['aside-marketplace'] = directory;
        agents.codexPlugins = [{ pluginId, enabled: true }, { pluginId: otherId, enabled: false }];
      }
      calls = [];
      await runPlugin(['remove', '--agent', agent], ctx());
      expect(changes()).toEqual([agent === 'claude'
        ? `claude plugin uninstall ${pluginId} --scope user`
        : `codex plugin remove ${pluginId}`]);
      if (agent === 'claude') {
        expect(agents.marketplaces).toEqual([{ name: 'aside-marketplace', path: directory }]);
        expect(agents.plugins).toEqual([{ id: otherId, scope: 'user', enabled: false }]);
      } else {
        expect(agents.codexMarketplaces['aside-marketplace']).toBe(directory);
        expect(agents.codexPlugins).toEqual([{ pluginId: otherId, enabled: false }]);
      }
    }
  });

  describe('claude', () => {
    it('adds the checkout as a marketplace and installs the plugin for the user, once', async () => {
      await runPlugin(['install', '--agent', 'claude'], ctx());
      expect(changes()).toEqual([
        `claude plugin marketplace add ${plugin()}`,
        'claude plugin install aside@aside-marketplace --scope user',
      ]);
      calls = [];
      lines = [];
      await runPlugin(['install', '--agent', 'claude'], ctx());
      expect(changes()).toEqual([]);
      expect(lines).toContain('claude: configuration unchanged');
      expect(lines.join('\n')).not.toContain('MCP connectivity:');
    });

    it.each(['source', 'command', 'cache', 'mode', 'skill'] as const)('refreshes an old plugin %s at the same marketplace while preserving disabled state', async (kind) => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: plugin() }];
      const oldCache = join(home, '.claude', 'plugins', 'cache', 'aside');
      if (kind === 'cache') {
        mkdirSync(join(oldCache, 'cli', 'dist'), { recursive: true });
        writeFileSync(join(oldCache, 'cli', 'dist', 'main.js'), 'old bundled runtime');
      }
      if (kind === 'skill') {
        cpSync(plugin(), oldCache, { recursive: true });
        writeFileSync(join(oldCache, 'skills/aside/SKILL.md'), 'outdated skill');
      }
      agents.plugins = [{
        id: pluginId,
        scope: 'user',
        enabled: false,
        readFromFolder: kind === 'source' ? root : plugin(),
        installPath: kind === 'cache' || kind === 'skill' ? oldCache : undefined,
        mcpServers: { aside: kind === 'command'
          ? { command: '/usr/bin/node', args: [join(root, 'cli/dist/main.js'), 'mcp'] }
          : { command: 'aside', args: ['mcp', ...(kind === 'mode' ? ['--legacy'] : [])] } },
      }];
      setEnabled('user', false);
      await runPlugin(['install', '--agent', 'claude'], ctx());
      expect(changes()).toEqual([
        'claude plugin marketplace remove aside-marketplace',
        `claude plugin marketplace add ${plugin()}`,
        `claude plugin install ${pluginId} --scope user`,
        `claude plugin disable ${pluginId} --scope user`,
      ]);
      expect(enabledAt('user')).toBe(false);
      expect(agents.plugins).toEqual([expect.objectContaining({ id: pluginId, enabled: false })]);
    });

    it('leaves a current PATH-based plugin and its instance arguments in place', async () => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: plugin() }];
      agents.plugins = [{ id: pluginId, scope: 'user', enabled: true, readFromFolder: plugin(), mcpServers: { aside: { command: 'aside', args: ['mcp', '--dir', '/my/instance'] } } }];
      await runPlugin(['install', '--agent', 'claude'], ctx());
      expect(changes()).toEqual([]);
      expect(agents.plugins[0].mcpServers?.aside.args).toEqual(['mcp', '--dir', '/my/instance']);
    });

    it('installs at user scope alongside a project-only install without touching the marketplace', async () => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: plugin() }];
      agents.plugins = [{ id: 'aside@aside-marketplace', scope: 'local' }];
      await runPlugin(['install', '--agent', 'claude'], ctx());
      expect(changes()).toEqual(['claude plugin install aside@aside-marketplace --scope user']);
    });

    it('refuses a marketplace that points elsewhere unless forced', async () => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/some/other/clone' }];
      await expect(runPlugin(['install', '--agent', 'claude'], ctx())).rejects.toThrow(/already points at \/some\/other\/clone.*--force/s);
      expect(changes()).toEqual([]);
      await runPlugin(['install', '--agent', 'claude', '--force'], ctx());
      expect(changes()).toEqual([
        'claude plugin marketplace remove aside-marketplace',
        `claude plugin marketplace add ${plugin()}`,
        'claude plugin install aside@aside-marketplace --scope user',
      ]);
    });

    it.each([true, false])('restores an existing user install and its enabled=%s choice after marketplace removal', async enabled => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = [{ id: pluginId, scope: 'user', enabled }];
      setEnabled('user', enabled);
      await runPlugin(['install', '--agent', 'claude', '--force'], ctx());
      expect(agents.plugins).toEqual([expect.objectContaining({ id: pluginId, scope: 'user', enabled })]);
      expect(enabledAt('user')).toBe(enabled);
      expect(changes()).toContain('claude plugin install aside@aside-marketplace --scope user');
      expect(changes().filter(c => c.includes('plugin disable'))).toHaveLength(enabled ? 0 : 1);
      calls = []; await runPlugin(['install', '--agent', 'claude'], ctx()); expect(changes()).toEqual([]);
    });

    it('restores every project destination and scope-specific choices rather than merged enabled flags', async () => {
      const first = join(root, 'project one'), second = join(root, 'project two');
      mkdirSync(first); mkdirSync(second);
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      // A local disable makes the merged CLI state false, despite the lower
      // user and shared-project settings remaining explicitly enabled.
      agents.plugins = [
        { id: pluginId, scope: 'user', enabled: false },
        { id: pluginId, scope: 'project', projectPath: first, enabled: false },
        { id: pluginId, scope: 'local', projectPath: first, enabled: false },
        { id: pluginId, scope: 'project', projectPath: second, enabled: false },
      ];
      setEnabled('user', true); setEnabled('project', true, first); setEnabled('local', false, first); setEnabled('project', false, second);
      await runPlugin(['install', '--agent', 'claude', '--force'], ctx());
      expect(agents.plugins).toHaveLength(4);
      expect(enabledAt('user')).toBe(true); expect(enabledAt('project', first)).toBe(true);
      expect(enabledAt('local', first)).toBe(false); expect(enabledAt('project', second)).toBe(false);
      const installs = directories.filter(c => c.args[1] === 'install');
      expect(installs).toEqual([
        { args: ['plugin', 'install', pluginId, '--scope', 'user'], cwd: undefined },
        { args: ['plugin', 'install', pluginId, '--scope', 'project'], cwd: first },
        { args: ['plugin', 'install', pluginId, '--scope', 'local'], cwd: first },
        { args: ['plugin', 'install', pluginId, '--scope', 'project'], cwd: second },
      ]);
      expect(changes().filter(c => c.includes('plugin enable'))).toEqual([]);
    });

    it('--print includes restoration commands in their project directories and makes no changes', async () => {
      const project = join(root, 'project one'); mkdirSync(project);
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = [{ id: pluginId, scope: 'local', projectPath: project, enabled: false }];
      setEnabled('local', false, project);
      await runPlugin(['install', '--agent', 'claude', '--force', '--print'], ctx());
      expect(changes()).toEqual([]); expect(enabledAt('local', project)).toBe(false);
      expect(lines.join('\n')).toContain(`(cd '${project}' && claude plugin install ${pluginId} --scope local)`);
      expect(lines.join('\n')).toContain(`(cd '${project}' && claude plugin disable ${pluginId} --scope local)`);
      expect(agents.marketplaces[0].path).toBe('/old/checkout');
    });

    it('preserves a disabled local override even when only the user install exists', async () => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = [{ id: pluginId, scope: 'user', enabled: false }];
      setEnabled('user', true); setEnabled('local', false);
      await runPlugin(['install', '--agent', 'claude', '--force'], ctx());
      expect(enabledAt('user')).toBe(true); expect(enabledAt('local')).toBe(false);
      expect(agents.plugins).toHaveLength(1);
      expect(changes()).toContain(`claude plugin disable ${pluginId} --scope local`);
    });

    it('--print does not issue already-enabled commands after installing an enabled scope', async () => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = [{ id: pluginId, scope: 'user', enabled: true }]; setEnabled('user', true);
      await runPlugin(['install', '--agent', 'claude', '--force', '--print'], ctx());
      expect(lines.filter(line => line.includes('plugin enable'))).toEqual([]);
      expect(changes()).toEqual([]);
    });

    it.each(['malformed', 'nonboolean'])('refuses %s scoped settings before marketplace removal', async problem => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = [{ id: pluginId, scope: 'user', enabled: false }]; setEnabled('user', false);
      writeFileSync(settingsFile('user'), problem === 'malformed' ? '{' : JSON.stringify({ enabledPlugins: { [pluginId]: 'false' } }));
      await expect(runPlugin(['install', '--agent', 'claude', '--force'], ctx())).rejects.toThrow(/No marketplace changes were made/);
      expect(changes()).toEqual([]);
    });

    it.each([true, false])('restores a worktree local installation using its main-checkout enabled=%s settings', async enabled => {
      const worktree = join(root, 'worktree'); mkdirSync(worktree);
      localRoots.set(worktree, root);
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = [{ id: pluginId, scope: 'local', projectPath: worktree, enabled }];
      setEnabled('local', enabled, worktree);
      const context = ctx(), runner = context.runner; context.cwd = worktree;
      context.runner = async (command, args, options) => command === 'git'
        ? ok(join(root, '.git')) : runner(command, args, options);
      await runPlugin(['install', '--agent', 'claude', '--force'], context);
      expect(agents.plugins).toContainEqual(expect.objectContaining({ scope: 'local', projectPath: worktree, enabled }));
      expect(enabledAt('local', worktree)).toBe(enabled);
      expect(existsSync(join(worktree, '.claude/settings.local.json'))).toBe(false);
    });

    it.each(['print', 'failure'])('does not repeat an enable for shared worktree settings in the %s plan', async mode => {
      const worktree = join(root, 'worktree one'); mkdirSync(worktree);
      localRoots.set(worktree, root);
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = [{ id: pluginId, scope: 'local', projectPath: worktree, enabled: true }];
      setEnabled('local', true, worktree);
      // Plugin installation runs from main, while the installation is recorded for a
      // worktree. Both commands write the same main-checkout local file.
      const context = ctx(), runner = context.runner;
      context.runner = async (command, args, options) => command === 'git' ? ok(join(root, '.git'))
        : mode === 'failure' && args[1] === 'install' ? { code: 1, stdout: '', stderr: 'Install interrupted' }
        : runner(command, args, options);
      if (mode === 'print') {
        await runPlugin(['install', '--agent', 'claude', '--force', '--print'], context);
        expect(lines.join('\n')).toContain(`(cd '${worktree}' && claude plugin install ${pluginId} --scope local)`);
        expect(lines.join('\n')).not.toContain('plugin enable');
        expect(changes()).toEqual([]);
      } else {
        const result = await runPlugin(['install', '--agent', 'claude', '--force'], context).then(() => null, error => error as Error);
        expect(result?.message).toContain('restoration is incomplete');
        expect(result?.message).toContain(`(cd '${worktree}' && claude plugin install ${pluginId} --scope local)`);
        expect(result?.message).not.toContain('plugin enable');
      }
    });

    it('reads and restores the configured Claude directory rather than the default home location', async () => {
      configDir = join(home, 'custom Claude directory');
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = [{ id: pluginId, scope: 'user', enabled: false }]; setEnabled('user', false);
      await runPlugin(['install', '--agent', 'claude', '--force'], ctx());
      expect(enabledAt('user')).toBe(false);
      expect(existsSync(join(home, '.claude/settings.json'))).toBe(false);
    });

    it('refuses an unresolved repository context before marketplace removal', async () => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      const context = ctx(), runner = context.runner;
      context.runner = async (command, args, options) => command === 'git'
        ? { code: 1, stdout: '', stderr: 'Git metadata inaccessible' } : runner(command, args, options);
      await expect(runPlugin(['install', '--agent', 'claude', '--force'], context)).rejects.toThrow(/Cannot locate Claude local settings.*No marketplace changes/s);
      expect(changes()).toEqual([]);
    });

    it.each(['missing path', 'missing setting', 'managed', 'other plugin'])('refuses an unsafe replacement before removing anything (%s)', async problem => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = problem === 'other plugin' ? [{ id: 'another@aside-marketplace', scope: 'user' }]
        : [{ id: pluginId, scope: problem === 'managed' ? 'managed' : problem === 'missing path' ? 'project' : 'user' }];
      await expect(runPlugin(['install', '--agent', 'claude', '--force'], ctx())).rejects.toThrow(/no.*changes|No.*changes/);
      expect(changes()).toEqual([]); expect(agents.marketplaces[0].path).toBe('/old/checkout');
    });

    it('reports incomplete restoration with the original scoped recovery commands', async () => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = [{ id: pluginId, scope: 'user', enabled: false }]; setEnabled('user', false);
      const context = ctx(), runner = context.runner;
      context.runner = async (command, args, options) => args[1] === 'install'
        ? { code: 1, stdout: '', stderr: 'Installation unavailable' } : runner(command, args, options);
      await expect(runPlugin(['install', '--agent', 'claude', '--force'], context)).rejects.toThrow(/Installation unavailable[\s\S]*restoration is incomplete[\s\S]*plugin install.*--scope user[\s\S]*plugin disable.*--scope user/);
      expect(agents.plugins).toEqual([]);
    });

    it('does not report completion when a successful CLI exit leaves the installation missing', async () => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
      agents.plugins = [{ id: pluginId, scope: 'user', enabled: true }]; setEnabled('user', true);
      const context = ctx(), runner = context.runner;
      context.runner = async (command, args, options) => args[1] === 'install'
        ? ok() : runner(command, args, options);
      await expect(runPlugin(['install', '--agent', 'claude', '--force'], context)).rejects.toThrow(/did not confirm every restored installation[\s\S]*restoration is incomplete/);
      expect(lines.join('\n')).not.toContain('start a new session');
      expect(agents.plugins).toEqual([]);
    });

    it('removes the user install, and the marketplace only when no other scope uses it', async () => {
      agents.marketplaces = [{ name: 'aside-marketplace', path: plugin() }];
      agents.plugins = [{ id: 'aside@aside-marketplace', scope: 'user' }, { id: 'aside@aside-marketplace', scope: 'local' }];
      await runPlugin(['remove', '--agent', 'claude'], ctx());
      expect(changes()).toEqual(['claude plugin uninstall aside@aside-marketplace --scope user']);

      calls = [];
      agents.plugins = [{ id: 'aside@aside-marketplace', scope: 'user' }];
      await runPlugin(['remove', '--agent', 'claude'], ctx());
      expect(changes()).toEqual([
        'claude plugin uninstall aside@aside-marketplace --scope user',
        'claude plugin marketplace remove aside-marketplace',
      ]);

      calls = [];
      lines = [];
      await runPlugin(['remove', '--agent', 'claude'], ctx());
      expect(changes()).toEqual([]);
      expect(lines).toContain('claude: nothing to remove');
    });

    it('prints the commands to run by hand when claude is not installed', async () => {
      found.claude = null;
      await expect(runPlugin(['install', '--agent', 'claude'], ctx())).rejects.toThrow(new RegExp(`claude plugin marketplace add ${plugin()}[\\s\\S]*claude plugin install aside@aside-marketplace --scope user`));
      expect(calls).toEqual([]);
    });
  });

  describe('codex', () => {
    it.each(['surface switch', 'former package', 'forced checkout replacement'])('refuses %s when another Codex plugin needs the marketplace', async reason => {
      const directory = reason === 'surface switch' ? plugin() : reason === 'former package' ? join(root, 'agent') : '/some/other/clone';
      agents.codexMarketplaces['aside-marketplace'] = directory;
      agents.codexPlugins = [{ pluginId: codexId, enabled: true }, { pluginId: 'other@aside-marketplace', enabled: false }];
      const options = reason === 'surface switch' ? ['--legacy'] : reason === 'forced checkout replacement' ? ['--force'] : [];
      await expect(runPlugin(['install', '--agent', 'codex', ...options], ctx())).rejects.toThrow(/other plugins use it: other@aside-marketplace.*no changes/s);
      expect(changes()).toEqual([]);
      expect(agents.codexMarketplaces['aside-marketplace']).toBe(directory);
      expect(agents.codexPlugins).toEqual([{ pluginId: codexId, enabled: true }, { pluginId: 'other@aside-marketplace', enabled: false }]);
    });

    it('installs only plugin configuration and skills, once', async () => {
      writeFileSync(join(root, 'cli', 'dist', 'runtime.js'), 'runtime');
      writeFileSync(join(root, 'cli', 'dist', 'regex-worker.js'), 'worker');
      await runPlugin(['install', '--agent', 'codex'], ctx());
      expect(changes()).toEqual([
        `codex plugin marketplace add ${plugin()}`,
        `codex plugin add ${codexId}`,
      ]);
      expect(readdirSync(plugin()).sort()).toEqual(['.claude-plugin', '.mcp.json', 'skills']);
      expect(lstatSync(join(plugin(), 'skills', 'aside')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(plugin(), 'skills', 'aside', 'SKILL.md'), 'utf8')).toContain('name: aside');
      expect(readdirSync(cache()).sort()).toEqual(readdirSync(plugin()).sort());
      expect(JSON.parse(readFileSync(join(cache(), '.mcp.json'), 'utf8')).mcpServers.aside).toEqual({ command: 'aside', args: ['mcp'] });
      expect(readFileSync(join(cache(), 'skills', 'aside', 'SKILL.md'), 'utf8')).toContain('name: aside');
      const text = lines.join('\n');
      expect(text).toContain(`codex: installed ${codexId}`);
      expect(lines).toEqual([
        `codex: added marketplace aside-marketplace → ${plugin()}`,
        `codex: installed ${codexId}`,
        'codex: start a new session, then invoke the skill with $aside',
      ]);
      expect(text).not.toContain('MCP connectivity:');

      calls = [];
      lines = [];
      await runPlugin(['install', '--agent', 'codex'], ctx());
      expect(changes()).toEqual([]);
      expect(lines).toEqual(['codex: configuration unchanged']);
    });

    it('keeps the installed plugin current after rebuilding runtime artifacts', async () => {
      await runPlugin(['install', '--agent', 'codex'], ctx());
      writeFileSync(join(root, 'cli', 'dist', 'main.js'), 'bundle v2');
      writeFileSync(join(root, 'cli', 'dist', 'aside-cal'), 'helper v2');
      writeFileSync(join(root, 'webapp', 'dist', 'app.js'), 'app v2');
      calls = [];
      lines = [];
      await runPlugin(['status'], ctx());
      expect(lines).toContain('[OK] Plugin files');
      await runPlugin(['install', '--agent', 'codex'], ctx());
      expect(changes()).toEqual([]);
      expect(existsSync(join(cache(), 'cli'))).toBe(false);
      expect(existsSync(join(cache(), 'webapp'))).toBe(false);
    });

    it.each(['.claude-plugin/plugin.json', '.mcp.json', 'skills/aside/SKILL.md'])('refreshes Codex after a %s change', async (file) => {
      await runPlugin(['install', '--agent', 'codex'], ctx());
      const revised = file === '.claude-plugin/plugin.json'
        ? JSON.stringify({ name: 'aside', version: '0.1.0', description: 'revised' })
        : file === '.mcp.json'
          ? JSON.stringify({ mcpServers: { aside: { command: 'aside', args: ['mcp'], env: { ASIDE_TEST: 'revised' } } } })
          : '---\nname: aside\n---\nrevised\n';
      writeFileSync(join(plugin(), file), revised);
      calls = [];
      lines = [];
      await runPlugin(['status'], ctx());
      expect(lines).toContain('[ERROR] Plugin files');
      await runPlugin(['install', '--agent', 'codex'], ctx());
      expect(changes()).toEqual([`codex plugin add ${codexId}`]);
      expect(readFileSync(join(cache(), file), 'utf8')).toBe(revised);
      expect(lines.join('\n')).toContain(`codex: refreshed ${codexId}`);
    });

    it.each(['bundled runtime', 'Codex manifest'])('replaces an old cache that still contains %s artifacts', async (kind) => {
      await runPlugin(['install', '--agent', 'codex'], ctx());
      if (kind === 'bundled runtime') {
        mkdirSync(join(cache(), 'cli', 'dist'), { recursive: true });
        writeFileSync(join(cache(), 'cli', 'dist', 'main.js'), 'old bundled CLI');
        writeFileSync(join(cache(), 'run-mcp'), '#!/bin/sh\n');
      } else {
        mkdirSync(join(cache(), '.codex-plugin'));
        writeFileSync(join(cache(), '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'aside', version: '0.1.0' }));
      }
      calls = [];
      await runPlugin(['install', '--agent', 'codex'], ctx());
      expect(changes()).toEqual([`codex plugin add ${codexId}`]);
      expect(existsSync(join(cache(), 'cli'))).toBe(false);
      expect(existsSync(join(cache(), 'run-mcp'))).toBe(false);
      expect(existsSync(join(cache(), '.codex-plugin'))).toBe(false);
      expect(readFileSync(join(cache(), '.mcp.json'), 'utf8')).toBe(readFileSync(join(plugin(), '.mcp.json'), 'utf8'));
    });

    it('does not refresh a disabled stale plugin, even with force', async () => {
      await runPlugin(['install', '--agent', 'codex'], ctx());
      agents.codexPlugins[0].enabled = false;
      writeFileSync(join(cache(), 'run-mcp'), '#!/bin/sh\n');
      calls = [];
      await expect(runPlugin(['install', '--agent', 'codex', '--force'], ctx())).rejects.toThrow(/disabled.*refresh.*no changes.*Enable the plugin/s);
      expect(changes()).toEqual([]);
      expect(agents.codexPlugins[0].enabled).toBe(false);
      expect(existsSync(join(cache(), 'run-mcp'))).toBe(true);
    });

    it('refuses a marketplace that points elsewhere unless forced', async () => {
      agents.codexMarketplaces['aside-marketplace'] = '/some/other/clone';
      await expect(runPlugin(['install', '--agent', 'codex'], ctx())).rejects.toThrow(/already points at \/some\/other\/clone.*--force/s);
      expect(changes()).toEqual([]);
      expect(existsSync(join(plugin(), 'cli'))).toBe(false);
      await runPlugin(['status'], ctx());
      expect(lines.join('\n')).toContain('plugin install --agent codex --force');
      await runPlugin(['install', '--agent', 'codex', '--force'], ctx());
      expect(changes()).toEqual([
        'codex plugin marketplace remove aside-marketplace',
        `codex plugin marketplace add ${plugin()}`,
        `codex plugin add ${codexId}`,
      ]);
    });

    it('reports a plugin that is installed but disabled, without re-enabling it', async () => {
      await runPlugin(['install', '--agent', 'codex'], ctx());
      agents.codexPlugins[0].enabled = false;
      calls = [];
      lines = [];
      await runPlugin(['install', '--agent', 'codex'], ctx());
      expect(changes()).toEqual([]);
      expect(lines).toContain('Error: Codex: Plugin');
      expect(lines.join('\n')).not.toContain('[OK]');
      expect(lines.join('\n')).toContain('Fix: enable the plugin in Codex');
      lines = [];
      await runPlugin(['install', '--agent=codex', '--print'], ctx());
      expect(lines).toContain('codex: installed but disabled; enable the plugin in Codex, then start a new session.');
    });

    it('removes the plugin and the marketplace', async () => {
      await runPlugin(['install', '--agent', 'codex'], ctx());
      calls = [];
      await runPlugin(['remove', '--agent', 'codex'], ctx());
      expect(changes()).toEqual([
        `codex plugin remove ${codexId}`,
        'codex plugin marketplace remove aside-marketplace',
      ]);
      calls = [];
      lines = [];
      await runPlugin(['remove', '--agent', 'codex'], ctx());
      expect(changes()).toEqual([]);
      expect(lines).toContain('codex: nothing to remove');
    });

    it('prints the commands to run by hand when codex is not installed', async () => {
      found.codex = null;
      await expect(runPlugin(['install', '--agent', 'codex'], ctx())).rejects.toThrow(new RegExp(`codex plugin marketplace add ${plugin()}[\\s\\S]*codex plugin add ${codexId}`));
      expect(existsSync(join(plugin(), 'cli'))).toBe(false);
      expect(calls).toEqual([]);
    });
  });

  it('--print shows every change and makes none', async () => {
    await runPlugin(['install', '--agent', 'codex', '--print'], ctx());
    expect(changes()).toEqual([]);
    expect(existsSync(join(plugin(), 'cli'))).toBe(false);
    expect(lines).toEqual([
      `codex plugin marketplace add ${plugin()}`,
      `codex plugin add ${codexId}`,
    ]);
  });

  it.each(['claude', 'codex'])('requires aside on PATH before installing the %s plugin', async (agent) => {
    const context = ctx();
    context.findAside = () => null;
    await expect(runPlugin(['install', '--agent', agent], context)).rejects.toThrow(/aside command was not found on PATH.*build\.sh/s);
    expect(calls).toEqual([]);

    await runPlugin(['install', '--agent', agent, '--print'], context);
    expect(changes()).toEqual([]);
    expect(lines.join('\n')).toContain(`${agent} plugin marketplace add`);

    await runPlugin(['remove', '--agent', agent], context);
    expect(changes()).toEqual([]);
  });

  it('status reports a missing PATH command and still inspects both agents', async () => {
    const context = ctx();
    context.findAside = () => null;
    await runPlugin(['status'], context);
    const text = lines.join('\n');
    expect(lines).toContain('[ERROR] aside on PATH');
    expect(text).not.toContain('MCP command:');
    expect(text).toContain('Claude Code\n[OK] CLI');
    expect(text).toContain('Codex\n[OK] CLI');
    expect(changes()).toEqual([]);
  });

  it.each(['current', 'former'])('status keeps recovery on the inspected checkout when PATH points to another %s checkout', async layout => {
    const otherRoot = join(home, 'other-checkout');
    const otherScript = join(otherRoot, 'cli', 'dist', 'main.js');
    if (layout === 'current') cpSync(root, otherRoot, { recursive: true });
    else {
      cpSync(plugin(), join(otherRoot, 'agent'), { recursive: true });
      mkdirSync(join(otherRoot, 'cli', 'dist'), { recursive: true });
      writeFileSync(otherScript, 'older launcher');
      expect(() => checkoutRoot(otherScript)).toThrow(/agent\/graphql/);
    }
    const context = ctx();
    context.findAside = () => otherScript;

    await runPlugin(['status'], context);

    expect(lines).toContain(`[ERROR] aside on PATH`);
    expect(lines).toContain(`  Fix: ${context.node} ${context.script} plugin install --agent claude`);
    expect(lines).toContain(`  Fix: ${context.node} ${context.script} plugin install --agent codex`);
    expect(lines.join('\n')).not.toContain('Fix: aside plugin ');
    expect(changes()).toEqual([]);
  });

  it('status reports each agent without changing anything', async () => {
    agents.marketplaces = [{ name: 'aside-marketplace', path: '/elsewhere' }];
    agents.plugins = [{ id: 'aside@aside-marketplace', scope: 'local' }];
    found.codex = null;
    await runPlugin(['status'], ctx());
    expect(changes()).toEqual([]);
    const text = lines.join('\n');
    expect(text).toContain(root);
    expect(text).toContain('Aside plugin status');
    expect(lines).toContain('[OK] aside on PATH');
    expect(lines).toContain('[OK] CLI launcher');
    expect(lines).toContain('[ERROR] Marketplace');
    expect(lines).toContain('[ERROR] Plugin');
    expect(text).toContain('Codex\n[ERROR] CLI');
    expect(text.split('\nCodex\n')[1]).not.toContain('Registration');

    lines = [];
    found.codex = 'codex';
    agents.marketplaces = [];
    agents.plugins = [];
    await runPlugin(['install', '--agent', 'codex'], ctx());
    writeFileSync(join(root, 'cli', 'dist', 'runtime.js'), 'runtime');
    writeFileSync(join(root, 'cli', 'dist', 'regex-worker.js'), 'worker');
    calls = [];
    lines = [];
    await runPlugin(['status'], ctx());
    for (const label of ['CLI launcher', 'CLI bundle', 'regex worker', 'webapp bundle']) {
      expect(lines).toContain(`[OK] ${label}`);
    }
    if (process.platform === 'darwin') expect(lines).toContain('[OK] calendar helper');
    expect(lines.join('\n').split('\nCLI\n')[1].split('\nClaude Code\n')[0]).not.toContain('[ERROR]');
    const codexReport = lines.join('\n').split('\nCodex\n')[1];
    expect(codexReport).toContain(`[OK] Marketplace`);
    expect(codexReport).toContain('[OK] Plugin');
    expect(codexReport).toContain('[OK] Plugin files');
    expect(lines).toContain('[ERROR] Marketplace'); // claude's
    expect(lines.join('\n').split('\nClaude Code\n')[1].split('\nCodex\n')[0]).not.toContain('Plugin load');
    expect(changes()).toEqual([]);
  });

  it.each([['user', true], ['user', false], ['project', true], ['local', false]] as const)('--status exposes reported %s plugin load errors independently of enabled=%s', async (scope, enabled) => {
    agents.marketplaces = [{ name: 'aside-marketplace', path: plugin() }];
    agents.plugins = [{ id: pluginId, scope, enabled, projectPath: scope === 'user' ? undefined : '/project/one', errors: ['Invalid plugin manifest', 'Missing cli/dist/main.js\nCheck the source build'], readFromFolder: root }];
    await runPlugin(['status'], ctx());
    const text = lines.join('\n');
    expect(lines).toContain(`[OK] Marketplace`);
    expect(lines).toContain(scope === 'user' && enabled ? '[OK] Plugin' : '[ERROR] Plugin');
    expect(lines).toContain('[ERROR] Plugin load');
    expect(text).toContain(`${scope}${scope === 'user' ? '' : ', /project/one'}: Invalid plugin manifest`);
    expect(text).toContain('Missing cli/dist/main.js');
    expect(text).toContain(`Fix: claude plugin validate ${root}`);
    expect(text).toContain('Fix: fix the reported plugin error');
    expect(text).toContain('/reload-plugins');
    expect(text).toContain('Codex\n[OK] CLI');
    expect(text).not.toContain('Registration: inspection failed');
    expect(changes()).toEqual([]);
  });

  it('reports load errors observed after installation without undoing registration', async () => {
    const context = ctx(), runner = context.runner;
    context.runner = async (command, args, options) => {
      const result = await runner(command, args, options);
      if (command === 'claude' && args.join(' ') === 'plugin list --json') return ok(JSON.stringify(agents.plugins.map(plugin => ({ ...plugin, errors: ['Plugin failed to load'] }))));
      return result;
    };
    await runPlugin(['install', '--agent', 'claude'], context);
    expect(changes()).toEqual([`claude plugin marketplace add ${plugin()}`, `claude plugin install ${pluginId} --scope user`]);
    expect(agents.plugins).toHaveLength(1);
    expect(lines).toContain('Error: Claude Code: Plugin load');
    expect(lines.join('\n')).toContain('Plugin failed to load');
  });

  it('validates the reported load directory and ignores unrelated plugins errors', async () => {
    agents.marketplaces = [{ name: 'aside-marketplace', path: '/old/checkout' }];
    agents.plugins = [
      { id: pluginId, scope: 'user', errors: ['Bad plugin'], installPath: '/actual plugin/directory' },
      { id: 'another@another-marketplace', scope: 'user', errors: ['Unrelated failure'] },
    ];
    await runPlugin(['status'], ctx());
    expect(lines.join('\n')).toContain("Fix: claude plugin validate '/actual plugin/directory'");
    expect(lines.join('\n')).not.toContain('Unrelated failure');
    expect(changes()).toEqual([]);
  });

  it.each([undefined, []])('does not claim MCP connectivity from an error-free plugin listing (%s)', async errors => {
    agents.marketplaces = [{ name: 'aside-marketplace', path: plugin() }];
    agents.plugins = [{ id: pluginId, scope: 'user', enabled: true, errors }];
    await runPlugin(['status'], ctx());
    expect(lines).toContain('[OK] Plugin load');
    expect(lines.join('\n')).not.toContain('MCP connectivity:');
    expect(lines.join('\n')).not.toContain('Fix: fix the reported plugin error');
    expect(changes()).toEqual([]);
  });

  it.each(['not an array', [123], null])('rejects uninspectable plugin diagnostics without modifying configuration (%s)', async errors => {
    agents.marketplaces = [{ name: 'aside-marketplace', path: plugin() }];
    agents.plugins = [{ id: pluginId, scope: 'user', errors }];
    await expect(runPlugin(['install', '--agent', 'claude'], ctx())).rejects.toThrow(/invalid load errors/);
    expect(changes()).toEqual([]);
    await expect(runPlugin(['status'], ctx())).rejects.toThrow(/Plugin inspection failed.*invalid load errors/s);
    expect(lines.join('\n')).toContain('Codex\n[OK] CLI');
    expect(changes()).toEqual([]);
  });

  it.each(['missing', 'current', 'disabled', 'stale', 'disabled and stale', 'elsewhere'] as const)('--status reports a %s Codex plugin independently from missing builds', async label => {
    if (label === 'elsewhere') agents.codexMarketplaces['aside-marketplace'] = '/elsewhere';
    else if (label !== 'missing') await runPlugin(['install', '--agent', 'codex'], ctx());
    const disabled = label === 'disabled' || label === 'disabled and stale';
    const stale = label === 'stale' || label === 'disabled and stale';
    if (disabled) agents.codexPlugins[0].enabled = false;
    if (stale) writeFileSync(join(plugin(), 'skills', 'aside', 'SKILL.md'), 'changed');
    rmSync(join(root, 'webapp', 'dist'), { recursive: true });
    calls = [];
    lines = [];
    await runPlugin(['status'], ctx());
    const text = lines.join('\n');
    const codexReport = text.split('\nCodex\n')[1];
    expect(codexReport).toContain('[OK] CLI');
    expect(codexReport).toContain(label === 'missing'
      ? '[ERROR] Marketplace'
      : label === 'elsewhere'
        ? '[ERROR] Marketplace'
        : `[OK] Marketplace`);
    if (label === 'missing' || label === 'elsewhere') {
      expect(codexReport).toContain('[ERROR] Plugin');
      expect(codexReport).not.toContain('Plugin files');
    } else {
      expect(codexReport).toContain(disabled ? '[ERROR] Plugin' : '[OK] Plugin');
      expect(codexReport).toContain(stale ? '[ERROR] Plugin files' : '[OK] Plugin files');
    }
    expect(lines).toContain('[ERROR] CLI bundle');
    expect(lines).toContain('[ERROR] regex worker');
    expect(lines).toContain('[ERROR] webapp bundle');
    expect(text).toContain(`  Fix: rebuild missing files with bash ${join(root, 'build.sh')}`);
    if (label === 'current') expect(codexReport).not.toContain('Fix:');
    else expect(codexReport).toContain('Fix:');
    if (label === 'elsewhere') expect(codexReport).toContain('plugin install --agent codex --force');
    if (disabled && stale) {
      expect(codexReport).toContain('Fix: enable the plugin in Codex before running aside plugin install; you can disable it again afterwards.');
      expect(codexReport).toContain('Fix: aside plugin install --agent codex');
      expect(agents.codexPlugins[0].enabled).toBe(false);
    }
    expect(changes()).toEqual([]);
  });

  it('status reports inspection failure, still checks the other agent, and fails', async () => {
    const context = ctx();
    const original = context.runner;
    context.runner = async (command, args) => command === 'claude'
      ? { code: 2, stdout: '', stderr: 'config is unreadable' }
      : original(command, args);
    await expect(runPlugin(['status'], context)).rejects.toThrow(/Plugin inspection failed.*config is unreadable/s);
    const text = lines.join('\n');
    expect(text).toContain('[ERROR] Registration');
    const codexReport = text.split('\nCodex\n')[1];
    expect(codexReport).toContain('[OK] CLI');
    expect(codexReport).toContain('[ERROR] Marketplace');
    expect(codexReport).toContain('[ERROR] Plugin');
    expect(changes()).toEqual([]);
  });

  it('rejects a Codex listing it cannot read without making changes', async () => {
    const context = ctx();
    context.runner = async () => ok(JSON.stringify({ marketplaces: 'none' }));
    await expect(runPlugin(['install', '--agent', 'codex'], context)).rejects.toThrow(/did not print a marketplace list/);
    expect(existsSync(join(plugin(), 'cli'))).toBe(false);
  });

  it('stops when an agent cannot report its state, rather than assuming nothing is registered', async () => {
    const broken = ctx();
    broken.runner = async (command, args) => {
      calls.push([command, ...args]);
      return { code: 2, stdout: '', stderr: 'config is unreadable' };
    };
    await expect(runPlugin(['install', '--agent', 'claude'], broken)).rejects.toThrow(/plugin marketplace list --json failed:\nconfig is unreadable/);
    await expect(runPlugin(['install', '--agent', 'codex'], broken)).rejects.toThrow(/plugin marketplace list --json failed/);
    expect(changes()).toEqual([]);
    expect(existsSync(join(plugin(), 'cli'))).toBe(false);
  });

  it.each([
    ['install', false, false], ['install', true, false], ['install', false, true],
    ['remove', false, false], ['remove', true, false], ['remove', false, true],
    ['status', false, false], ['status', true, false], ['status', false, true],
  ] as const)('reports recovery for a moved Codex marketplace on %s (legacy=%s, json=%s)', async (operation, legacy, json) => {
    const context = ctx(), original = context.runner;
    const diagnostic = `Error: failed to load marketplace(s):\n- \`aside-marketplace\` at ${join(root, 'agent')}: marketplace root does not contain a supported manifest`;
    context.runner = async (command, args, options) => {
      if (command === 'codex' && args.join(' ') === 'plugin marketplace list --json') {
        calls.push([command, ...args]);
        return { code: 1, stdout: '', stderr: diagnostic };
      }
      return original(command, args, options);
    };
    const result = runPlugin([operation, ...(operation === 'status' ? [] : ['--agent', 'codex']),
      ...(legacy ? ['--legacy'] : []), ...(json ? ['--json'] : [])], context);
    const fixes = ['codex plugin marketplace remove aside-marketplace', `aside plugin ${operation === 'remove' ? 'remove' : 'install'} --agent codex${legacy ? ' --legacy' : ''}`];
    await expect(result).rejects.toThrow(diagnostic);
    if (json) {
      const report = JSON.parse(lines.join('\n'));
      expect(report.ok).toBe(false);
      expect(report.checks.find((check: { code: string }) => check.code === (operation === 'status' ? 'codex_registration' : 'plugin_operation'))?.fixes).toEqual(fixes);
    } else if (operation === 'status') {
      for (const fix of fixes) expect(lines.join('\n')).toContain(`Fix: ${fix}`);
    } else {
      await expect(result).rejects.toThrow(`${diagnostic}\n${fixes.map(fix => `Fix: ${fix}`).join('\n')}`);
      expect(lines).toEqual([]);
    }
    expect(changes()).toEqual([]);
  });

  it('does not suggest removing Aside when a different Codex marketplace has a missing manifest', async () => {
    const context = ctx();
    context.runner = async (command, args) => {
      calls.push([command, ...args]);
      return { code: 1, stdout: '', stderr: 'Error: failed to load marketplace(s):\n- `other-marketplace` at /other: marketplace root does not contain a supported manifest' };
    };
    await expect(runPlugin(['install', '--agent', 'codex'], context)).rejects.toThrow('other-marketplace');
    expect(lines.join('\n')).not.toContain('Fix:');
    expect(changes()).toEqual([]);
  });

  it('reports a plugin that is installed but disabled', async () => {
    agents.marketplaces = [{ name: 'aside-marketplace', path: plugin() }];
    agents.plugins = [{ id: 'aside@aside-marketplace', scope: 'user', enabled: false }];
    await runPlugin(['install', '--agent', 'claude'], ctx());
    expect(lines.join('\n')).toContain('claude plugin enable aside@aside-marketplace');
    lines = [];
    await runPlugin(['status'], ctx());
    expect(lines).toContain('[ERROR] Plugin');
  });

  it('rejects malformed invocations without agent calls', async () => {
    await expect(runPlugin(['install'], ctx())).rejects.toThrow(/required option '--agent/);
    await expect(runPlugin(['install', '--agent', 'cursor'], ctx())).rejects.toThrow(/must be claude, codex/);
    await expect(runPlugin(['claude'], ctx())).rejects.toThrow(/unknown command/);
    await expect(runPlugin(['--status'], ctx())).rejects.toThrow(/unknown option/);
    await expect(runPlugin(['install', '--agent', 'claude', 'codex'], ctx())).rejects.toThrow(/too many arguments/);
    await expect(runPlugin(['install', '--agent', 'claude', '--nope'], ctx())).rejects.toThrow(/unknown option '--nope'/);
    await expect(runPlugin(['install', '--agent', 'claude', '--print', '--print'], ctx())).rejects.toThrow(/duplicate option --print/);
    await expect(runPlugin(['remove', '--agent', 'claude', '--force'], ctx())).rejects.toThrow(/unknown option '--force'/);
    await expect(runPlugin(['status', '--agent', 'claude'], ctx())).rejects.toThrow(/unknown option '--agent'/);
    expect(calls).toEqual([]);
  });

  it('finds the checkout root from the bundle path, and rejects a bundle outside a checkout', () => {
    expect(checkoutRoot(join(root, 'cli', 'dist', 'main.js'))).toBe(root);
    expect(() => checkoutRoot(join(home, 'cli', 'dist', 'main.js'))).toThrow(/works from a source checkout/);
  });
});

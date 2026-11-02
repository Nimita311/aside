import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { Daemon } from '../src/daemon/daemon.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { daemonPaths } from '../src/daemon/paths.js';
import { ownHello, type HelloResult } from '../src/daemon/protocol.js';
import type { AutomationInspection } from '../src/automation/controller.js';

let root: string, daemon: Daemon, host: InstanceHost;
beforeEach(() => { root = realpathSync(mkdtempSync('/tmp/aside-auto-d-')); });
afterEach(async () => { await daemon?.shutdown(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
async function until(check: () => boolean | Promise<boolean>, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (!(await check())) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 20)); }
}
function manifest(instance: string, automations: unknown) { writeFileSync(join(instance, 'aside.md'), `---\n${stringify({ id: 'work', automations })}---\n`); }
async function start(instance: string) {
  const paths = daemonPaths({ ASIDE_DAEMON_HOME: join(root, 'daemon') }); mkdirSync(paths.state, { recursive: true });
  writeFileSync(paths.known, JSON.stringify([instance]));
  host = new InstanceHost(new CalClient(null)); daemon = new Daemon({ paths, host, webPort: 0 }); expect(await daemon.listen()).toBe(true);
}
describe('daemon automation integration', () => {
  it('discovers a raw YAML built-in selection before its deadline and executes through the compiled worker', async () => {
    const instance = join(root, 'instance'), bin = join(root, 'bin'); mkdirSync(instance); mkdirSync(bin);
    vi.stubEnv('ASIDE_DAEMON_HOME', join(root, 'daemon'));
    vi.stubEnv('PATH', bin + delimiter + dirname(process.execPath));
    const fake = join(bin, 'codex');
    writeFileSync(fake, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const log = ${JSON.stringify(join(root, 'vendor.log'))};
if (process.argv[2] === 'app-server') {
  fs.appendFileSync(log, 'discover\\n');
  require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const result = message.method === 'model/list' ? { data: [{ model: 'vendor/model.v7', displayName: 'Vendor model' }] } : {};
    console.log(JSON.stringify({ id: message.id, result }));
  });
} else {
  fs.appendFileSync(log, 'execute\\n');
  let prompt = ''; process.stdin.on('data', chunk => prompt += chunk);
  process.stdin.on('end', () => console.log(JSON.stringify({ args: process.argv.slice(2), prompt })));
}
`); chmodSync(fake, 0o700);
    mkdirSync(join(instance, 'artifacts', '2026'), {recursive: true});
    writeFileSync(join(instance, 'artifacts', '2026', '2026-10-08-instructions.md'), '---\nname: Instructions\ncreated: 2026-10-08T12:00\n---\n\nOrganize this instance.');
    manifest(instance, { raw: { schedule: { at: new Date(Date.now() + 2500).toISOString() }, run: { model: 'CODEX_VENDOR_MODEL_V7', prompt: '#artifact/2026-10-08-instructions' } } });
    await start(instance);
    await until(async () => (await host.automationStatus()).runs.some(run => run.status === 'succeeded'));
    const [run] = (await host.automationStatus()).runs;
    expect(run.model).toEqual({ name: 'CODEX_VENDOR_MODEL_V7', engine: 'codex', model: 'vendor/model.v7' });
    const output = JSON.parse(readFileSync(join(run.directory, 'stdout.log'), 'utf8'));
    expect(output.args.slice(output.args.indexOf('--model'), output.args.indexOf('--model') + 2)).toEqual(['--model', 'vendor/model.v7']);
    expect(output.prompt).toContain('This is an Aside automation execution.');
    expect(output.prompt).toMatch(/Instance: [^\n]+\nAutomation name: raw\n/);
    expect(output.prompt).not.toContain('Project:');
    expect(output.prompt).not.toContain('Source:');
    expect(output.prompt).toContain("User's instruction: #artifact/2026-10-08-instructions");
    expect(output.prompt).not.toContain('Organize this instance.');
    expect(readFileSync(join(root, 'vendor.log'), 'utf8')).toBe('discover\nexecute\n');
  });
  it('reads the instruction artifact through MCP from another instance using the wrapper instance ID', async () => {
    const instance = join(root, 'instance'), elsewhere = join(root, 'elsewhere');
    mkdirSync(instance); mkdirSync(elsewhere);
    vi.stubEnv('ASIDE_DAEMON_HOME', join(root, 'daemon'));
    const artifactId = '2026-10-08-instructions';
    const instructions = 'Read these current instructions through Aside.';
    for (const [path, text] of [[instance, instructions], [elsewhere, 'Wrong instance instructions.']]) {
      mkdirSync(join(path, 'artifacts', '2026'), {recursive: true});
      writeFileSync(join(path, 'artifacts', '2026', artifactId + '.md'),
        '---\nname: Instructions\ncreated: 2026-10-08T12:00\n---\n\n' + text);
    }
    writeFileSync(join(elsewhere, 'aside.md'), '---\nid: other\n---\n');
    const agent = join(root, 'read-agent.cjs');
    writeFileSync(agent, `
const requireSDK = require('node:module').createRequire(${JSON.stringify(join(__dirname, '../package.json'))});
const {Client} = requireSDK('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport} = requireSDK('@modelcontextprotocol/sdk/client/stdio.js');
let prompt = '';
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', async () => {
  const client = new Client({name: 'instruction-reader', version: '1'});
  try {
    const instanceId = /^Instance: (.+)$/m.exec(prompt)[1];
    const artifactId = new RegExp("^User's instruction: #artifact/(.+)$", "m").exec(prompt)[1];
    await client.connect(new StdioClientTransport({command: process.execPath,
      args: [${JSON.stringify(join(__dirname, '../dist/main.js'))}, 'mcp'], cwd: process.cwd(), env: process.env}));
    const call = async (name, document, variables) => {
      const reply = await client.callTool({name, arguments: {document, ...(variables ? {variables} : {})}});
      const result = JSON.parse(reply.content.find(item => item.type === 'text').text);
      if (reply.isError || result.errors) throw new Error(JSON.stringify(result));
      return result.data;
    };
    const discovered = await call('query', '{activeInstance {id} instances {id path}}');
    const selected = discovered.instances.find(instance => instance.id === instanceId);
    if (!selected) throw new Error('Owning instance was not discoverable');
    await call('mutate', 'mutation($path: String!) {selectInstance(path: $path) {instance {id}}}', {path: selected.path});
    const read = await call('query', 'query($id: ID!) {activeInstance {id} artifact(id: $id) {content {... on MarkdownContent {text}}}}', {id: artifactId});
    console.log(JSON.stringify({cwd: process.cwd(), initialInstance: discovered.activeInstance.id,
      selectedInstance: read.activeInstance.id, instructions: read.artifact.content.text}));
  } catch (error) {console.error(error.stack); process.exitCode = 1;}
  finally {await client.close();}
});
`);
    writeFileSync(join(instance, '.aside'), stringify({execution: {cwd: elsewhere,
      models: {reader: {command: process.execPath, args: [agent]}}}}));
    manifest(instance, {read: {schedule: {at: new Date(Date.now() + 1500).toISOString()},
      run: {model: 'reader', prompt: '#artifact/' + artifactId}}});
    await start(instance);
    // A bundled client is newer than an unbundled source daemon. Keep this
    // test fixture alive instead of exercising the build-replacement protocol.
    const hello = ownHello();
    vi.spyOn(daemon as unknown as {hello(): HelloResult}, 'hello').mockReturnValue({
      ...hello, build: {...hello.build, builtAt: Number.MAX_SAFE_INTEGER}, pid: process.pid});
    await until(async () => (await host.automationStatus()).runs.some(run => run.finished), 8000);
    const [run] = (await host.automationStatus()).runs;
    expect(run.status, readFileSync(join(run.directory, 'stderr.log'), 'utf8')).toBe('succeeded');
    expect(JSON.parse(readFileSync(join(run.directory, 'stdout.log'), 'utf8'))).toEqual({
      cwd: elsewhere, initialInstance: 'other', selectedInstance: 'work', instructions});
    expect(run.prompt).not.toContain(instructions);
    expect(run.prompt).toContain('Instance: work');
  }, 10000);
  it('ingests GraphQL and entity-tool automation writes and disables them immediately', async () => {
    const instance = join(root, 'instance'); mkdirSync(instance); manifest(instance, {});
    await start(instance);
    const automations = { digest: { schedule: { cron: '0 8 * * *', timezone: 'UTC' }, run: { script: 'echo', args: ['digest'] } } };
    const result = JSON.parse((await host.tool(instance, 'mutate', {
      document: 'mutation($jobs: [CreateAutomationInput!]!) { updateInstance(input: {automations: {set: $jobs}}) { instance { automations { nodes { name run { script args } } } } error } }', variables: { jobs: Object.entries(automations).map(([name, definition]) => ({name, ...definition})) },
    })).text);
    expect(result.errors).toBeUndefined();
    await until(async () => { const report = await host.automationStatus(); return report.jobs.length === 1 && !!report.jobs[0].next; });
    const capture = await host.tool(instance, 'capture', { content: 'Setup digest', description: 'Setup digest', projects: [{ name: 'Digest', description: 'Digest', automations }] });
    expect(capture.text).toContain('digest');
    await until(async () => (await host.automationStatus()).jobs.length === 2);
    const project = (await host.automationStatus()).jobs.find(job => job.definedIn.startsWith('#project/'))!.definedIn.slice('#project/'.length);
    await host.tool(instance, 'update_project', { id: project, automations: { digest: { ...automations.digest, enabled: false } } });
    await host.tool(instance, 'update_instance', { automations: null });
    await until(async () => { const report = await host.automationStatus(); return report.jobs.length === 1 && !report.jobs[0].next; });
    expect((await host.automationStatus()).runs).toHaveLength(0);
  });
  it('ingests instance and project edits, runs once through the worker and skips past declarations after restart', async () => {
    const instance = join(root, 'instance'); mkdirSync(instance);
    const script = join(instance, 'work.js'); writeFileSync(script, '#!/usr/bin/env node\nconsole.log("executed");'); chmodSync(script, 0o700);
    manifest(instance, { past: { schedule: { at: '2000-01-01T00:00Z' }, run: { script: './work.js' } } });
    await start(instance);
    let report: AutomationInspection;
    await until(async () => (await host.automationStatus()).jobs.length === 1);
    expect((await host.automationStatus()).runs).toHaveLength(0);
    const future = new Date(Date.now() + 1200).toISOString();
    manifest(instance, { once: { schedule: { at: future }, run: { script: './work.js' } }, invalid: { schedule: { cron: 'bad' }, run: { script: './work.js' } } });
    await until(async () => (await host.automationStatus()).jobs.some(job => job.next === future));
    await until(async () => (await host.automationStatus()).runs.some(run => run.status === 'succeeded'));
    report = await host.automationStatus(); expect(report.runs).toHaveLength(1);
    expect(readFileSync(join(report.runs[0].directory, 'stdout.log'), 'utf8')).toBe('executed\n');
    expect(report.jobs.some(job => job.error?.includes('five'))).toBe(true);
    expect(host.issues(instance).some(issue => issue.code === 'automation_error')).toBe(true);
    const projectDir = join(instance, 'projects', '2026'); mkdirSync(projectDir, { recursive: true });
    const file = join(projectDir, '2026-10-08-notes.md');
    writeFileSync(file, `---\n${stringify({ name: 'Notes', created: '2026-10-08T12:00', automations: { daily: { schedule: { cron: '0 8 * * *', timezone: 'UTC' }, run: { script: './work.js' } } } })}---\n`);
    await until(async () => (await host.automationStatus()).jobs.some(job => job.definedIn === '#project/2026-10-08-notes'));
    await host.tool(instance, 'update_project', { id: '2026-10-08-notes', ended: '2026-10-08T12:00' });
    await until(async () => !(await host.automationStatus()).jobs.some(job => job.definedIn === '#project/2026-10-08-notes'));
    await daemon.shutdown(); await start(instance);
    await until(async () => (await host.automationStatus()).jobs.length === 2);
    report = await host.automationStatus(); expect(report.runs).toHaveLength(1); expect(report.jobs.every(job => !job.next)).toBe(true);
  });
  it('blocks duplicate instance identities and resumes after resolving the conflict', async () => {
    const one = join(root, 'one'), two = join(root, 'two'); mkdirSync(one); mkdirSync(two);
    const automation = { digest: { schedule: { cron: '0 8 * * *', timezone: 'UTC' }, run: { script: 'echo' } } };
    manifest(one, automation); manifest(two, automation);
    await start(one); host.load(two);
    await until(async () => { const report = await host.automationStatus(); return report.jobs.length === 2 && report.jobs.every(job => !!job.error); });
    writeFileSync(join(two, 'aside.md'), `---\n${stringify({ id: 'personal', automations: automation })}---\n`);
    await until(async () => { const report = await host.automationStatus(); return report.jobs.length === 2 && report.jobs.every(job => !!job.next && !job.error); });
  });
});

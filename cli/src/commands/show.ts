import { resolve } from 'node:path';
import { jsonResult, writeOutput } from './output.js';
import { parseCommand, type CommandInput } from './options.js';
import { resolveDataDir } from './mcp.js';
import { InstancePathError } from '../core/instance.js';
import { parseShowTarget, type ShowTarget } from './show-target.js';
import { availableInstances, resolveInstanceAddress } from '../web/catalogue.js';
import { openBrowser } from '../web/locate.js';
import { DaemonClient } from '../daemon/client.js';
import type { ShowResult } from '../daemon/host.js';
import type { Status } from '../daemon/protocol.js';

export interface ShowContext {
  cwd?: string;
  client?: () => Pick<DaemonClient, 'request' | 'close'>;
  open?: typeof openBrowser;
  out?: (line: string) => void;
}

async function targetInstance(target: ShowTarget, directory: string | undefined, cwd: string,
  client: Pick<DaemonClient, 'request'>): Promise<string> {
  const workspace = resolveDataDir(cwd, directory === undefined ? [] : ['--dir', directory]);
  if (workspace.invalidDir) throw new InstancePathError(`Not an aside instance (no aside.md manifest): ${workspace.invalidDir}`);
  if (!target.instanceId && workspace.dataDir) return workspace.dataDir;
  if (target.instanceId && directory !== undefined) {
    const instance = availableInstances([workspace.dataDir!]).find(instance => instance.path === workspace.dataDir);
    if (instance?.error) throw new Error(instance.error);
    if (instance?.id !== target.instanceId && instance?.alias !== target.instanceId) throw new Error(`The URL names instance "${target.instanceId}", but --dir selects "${instance?.id}".`);
    return workspace.dataDir!;
  }
  const { known } = await client.request<Status>('status', {}, { read: true });
  const instances = availableInstances([...known, ...workspace.candidates]);
  if (target.instanceId) {
    const instance = resolveInstanceAddress(instances, target.instanceId);
    if (!instance) throw new Error(`Instance "${target.instanceId}" is unavailable. Use aside show to choose its directory, or pass --dir <path>.`);
    if (instance.error) throw new Error(instance.error);
    return instance.path;
  }
  if (instances.length === 1) {
    if (instances[0].error) throw new Error(instances[0].error);
    return instances[0].path;
  }
  const choices = instances.map(instance => `  ${instance.name || instance.id || 'Instance'}: ${instance.path}`).join('\n');
  throw new Error(`Cannot choose an instance for this handle. Pass --dir <path> or use an aside:// URL.${choices ? `\nInstances:\n${choices}` : '\nUse aside show to open the instance selector.'}`);
}

export async function runShow(args: CommandInput, context: ShowContext = {}): Promise<void> {
  const options = parseCommand('show', args);
  if (options.helpText) { (context.out ?? console.log)(options.helpText); return; }
  const rawTarget = options.get('target');
  const printUrl = options.has('--url');
  if (rawTarget === undefined && options.has('--dir') && !printUrl) options.fail('--dir requires a URL or handle target, or --url. Run aside show for the instance selector.');
  let target: ShowTarget | undefined;
  if (rawTarget !== undefined) {
    try { target = parseShowTarget(rawTarget); }
    catch (error) { options.fail((error as Error).message); }
  } else if (printUrl && options.has('--dir')) {
    target = { args: {} };
  }
  const cwd = context.cwd ?? process.cwd();
  const appDir = options.get('--app-dir');
  const client = (context.client ?? (() => new DaemonClient()))();
  try {
    let result: { port: number; route: string; tab?: boolean; url?: string; launchUrl?: string };
    if (target) {
      const instance = await targetInstance(target, options.get('--dir'), cwd, client);
      const params = { instance, args: target.args, ...(appDir ? { appDir: resolve(cwd, appDir) } : {}) };
      result = printUrl
        ? await client.request<ShowResult>('show', { ...params, navigate: false }, { read: true })
        : await client.request<ShowResult>('show', params);
    } else {
      result = await client.request<ShowResult>('serve', { ...(appDir ? { appDir: resolve(cwd, appDir) } : {}), ...(printUrl ? { navigate: false } : {}) });
    }
    const url = result.url ?? `http://localhost:${result.port}/${result.route}`;
    if (!printUrl && !(await (context.open ?? openBrowser)(result.launchUrl ?? url)))
      throw new Error(`Could not open the browser. Run aside show locally to authorize it, then open ${url}`);
    writeOutput(options.has('--json') ? jsonResult('show', { url, reused_tab: false })
      : printUrl ? url : `Opened browser: ${url}`, options.has('--json'), context.out ?? console.log);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    error.message = error.message.replace(/\nHint: use query_\w+[^\n]*/g, '\nCheck the handle and instance directory; use aside show to open the selector.');
    throw error;
  } finally {
    client.close();
  }
}

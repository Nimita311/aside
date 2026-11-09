import {resolve} from 'node:path';
import {DAEMON_COMMAND_LOCK_TIMEOUT_MS} from '../core/system-config.js';
import {DaemonClient, tryConnect} from '../daemon/client.js';
import {FileLock} from '../daemon/filelock.js';
import {daemonPaths, ensureDirs} from '../daemon/paths.js';
import {init, type InitOptions, type InitResult} from '../source/bootstrap.js';
import {publishReport} from './output.js';
import {parseCommand, type CommandInput} from './options.js';

// Bootstrap through the existing source owner, without registering the instance
// or starting a daemon just to create files. Offline writes own both daemon
// startup gates so a concurrently starting owner cannot miss their publication.
async function bootstrap(path: string, input: InitOptions): Promise<InitResult> {
  const paths = daemonPaths();
  let running = await tryConnect(paths);
  let owner: DaemonClient | undefined;
  let startLock: FileLock | undefined, lifetimeLock: FileLock | undefined;
  try {
    if (!running) {
      ensureDirs(paths);
      startLock = new FileLock(paths.startLock);
      if (!(await startLock.acquireWait(DAEMON_COMMAND_LOCK_TIMEOUT_MS))) throw new Error('Cannot initialize the instance: another process holds the daemon start lock.');
      running = await tryConnect(paths);
      if (!running) {
        lifetimeLock = new FileLock(paths.lifetimeLock);
        if (!lifetimeLock.tryAcquire()) throw new Error('Cannot initialize the instance: the daemon is starting, stopping, or unavailable. No changes were made. Retry when the daemon is reachable or has exited.');
      }
    }
    if (!running) return init(path, input);
    // Settlement takes its own start lock when upgrading this owner.
    startLock?.release(); startLock = undefined;
    owner = new DaemonClient({paths, startIfMissing: false, initialConnection: running});
    return await owner.request<InitResult>('instance.bootstrap', {input: {...input, path}});
  } finally {
    if (owner) owner.close(); else running?.peer.close();
    lifetimeLock?.release(); startLock?.release();
  }
}

export async function runInit(args: CommandInput): Promise<void> {
  const options = parseCommand('instance', Array.isArray(args) ? ['init', ...args] : args);
  if (options.helpText) {console.log(options.helpText); return;}
  const result = await bootstrap(resolve(options.get('--dir')!), {
    name: options.get('--name')!, description: options.get('--description')!,
    body: options.get('--body'), tutorial: options.has('--tutorial'),
  });
  publishReport({title: 'Aside instance created', data: result,
    sections: [{name: 'Information', fields: {Directory: result.dataDir}},
      {name: 'Created files', entries: result.created.map(name => ({name}))}], checks: []}, 'instance init', options.has('--json'));
}

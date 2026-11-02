import { join, resolve } from 'node:path';
import { DAEMON_COMMAND_LOCK_TIMEOUT_MS } from '../core/system-config.js';
import { GraphQLUsageLog } from '../graphql/usage.js';
import { RunStorage } from '../automation/storage.js';
import { tryConnect } from '../daemon/client.js';
import { daemonPaths, ensureDirs } from '../daemon/paths.js';
import { FileLock } from '../daemon/filelock.js';
import { instanceKey } from '../daemon/host.js';
import type { DiagnosticCleanupResult } from '../daemon/protocol.js';
import { parseCommand, type CommandInput } from './options.js';
import { publishReport } from './output.js';

export async function runDiagnostics(input: CommandInput, cwd = process.cwd(), out: (text: string) => void = console.log): Promise<void> {
  const options = parseCommand('diagnostics', input);
  const root = options.has('--all') ? undefined : instanceKey(resolve(cwd, options.get('--dir')!));
  const paths = daemonPaths();
  ensureDirs(paths);
  let running = await tryConnect(paths);
  let start: FileLock | undefined, lifetime: FileLock | undefined;
  let result: DiagnosticCleanupResult;
  try {
    if (!running) {
      start = new FileLock(paths.startLock);
      if (!(await start.acquireWait(DAEMON_COMMAND_LOCK_TIMEOUT_MS))) throw new Error('Cannot purge diagnostics: another process holds the start lock.');
      running = await tryConnect(paths);
      if (!running) {
        lifetime = new FileLock(paths.lifetimeLock);
        if (!lifetime.tryAcquire()) throw new Error('Cannot purge diagnostics: the daemon is starting, stopping, or unavailable. Retry when it is reachable or has exited.');
      }
    }
    if (running) result = await running.peer.request<DiagnosticCleanupResult>('diagnostics.purge', {root});
    else {
      const usage = await new GraphQLUsageLog({logs: paths.logs}).purge(root);
      const automation = new RunStorage(join(paths.state, 'automation')).purge(root);
      result = {usage, automation};
    }
  } finally {
    running?.peer.close();
    lifetime?.release(); start?.release();
  }
  publishReport({title: 'Diagnostic history purged', data: result, checks: [], sections: [{name: 'Removed', fields: {
    Scope: root ?? 'all instances', 'Usage files': result.usage.files, 'Usage collections': result.usage.collections,
    'Automation runs': result.automation.runs,
  }}]}, 'diagnostics purge', options.has('--json'), out);
}

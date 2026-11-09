import { existsSync } from 'node:fs';
import { DaemonClient, tryConnect } from '../daemon/client.js';
import { collectKnownFile } from '../daemon/daemon.js';
import { daemonPaths } from '../daemon/paths.js';

// A local validation failure may never have reached the daemon. Ask its owner
// to collect, or take the offline locks. Do not start a stopped daemon.
export async function collectAfterFailedUse(): Promise<void> {
  const paths = daemonPaths();
  const running = await tryConnect(paths);
  if (!running) { if (existsSync(paths.known)) collectKnownFile(paths); return; }
  const owner = new DaemonClient({paths, startIfMissing: false, initialConnection: running});
  try { await owner.request('registry.reconcile'); }
  finally { owner.close(); }
}

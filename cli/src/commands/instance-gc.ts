import { existsSync } from 'node:fs';
import { tryConnect } from '../daemon/client.js';
import { collectKnownFile } from '../daemon/daemon.js';
import { daemonPaths } from '../daemon/paths.js';

// A local validation failure may never have reached the daemon. Ask its owner
// to collect, or take the offline locks. This must never launch a daemon.
export async function collectAfterFailedUse(): Promise<void> {
  const paths = daemonPaths();
  if (!existsSync(paths.known)) return;
  const running = await tryConnect(paths);
  if (!running) { collectKnownFile(paths); return; }
  try { await running.peer.request('status'); }
  finally { running.peer.close(); }
}

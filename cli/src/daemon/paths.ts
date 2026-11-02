// Where the daemon keeps its files (see design/daemon.md, Files). On macOS the
// socket, locks, and known-instances list live in Application Support and the
// log in Logs; elsewhere they follow the XDG state directory. ASIDE_DAEMON_HOME
// relocates everything under one directory (tests, isolated runs).
import { chmodSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const BUNDLE_ID = 'sh.117.aside';
export const JOB_LABEL = `${BUNDLE_ID}.daemon`;

export interface DaemonPaths {
  // The resolved relocation, carried to detached and launchd children. Null
  // keeps the platform's default state and log locations.
  homeOverride: string | null;
  state: string;
  logs: string;
  socket: string;
  startLock: string;
  lifetimeLock: string;
  known: string;
  log: string;
  // The login job's plist; null where launchd is unavailable.
  job: string | null;
}

export function daemonPaths(env: NodeJS.ProcessEnv = process.env): DaemonPaths {
  const override = env.ASIDE_DAEMON_HOME ? resolve(env.ASIDE_DAEMON_HOME) : null;
  let state: string;
  let logs: string;
  let agents: string | null;
  if (override) {
    state = override;
    logs = join(override, 'logs');
    agents = process.platform === 'darwin' ? join(override, 'LaunchAgents') : null;
  } else if (process.platform === 'darwin') {
    state = join(homedir(), 'Library', 'Application Support', BUNDLE_ID);
    logs = join(homedir(), 'Library', 'Logs', BUNDLE_ID);
    agents = join(homedir(), 'Library', 'LaunchAgents');
  } else {
    state = join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), BUNDLE_ID);
    logs = join(state, 'logs');
    agents = null;
  }
  const socket = join(state, 'daemon.sock');
  // sun_path is 104 bytes on macOS (108 on Linux), terminator included.
  if (Buffer.byteLength(socket) > 103) {
    throw new Error(`Daemon socket path is too long (${Buffer.byteLength(socket)} bytes, max 103): ${socket}`);
  }
  return {
    homeOverride: override,
    state,
    logs,
    socket,
    startLock: join(state, 'start.lock'),
    lifetimeLock: join(state, 'daemon.lock'),
    known: join(state, 'known.json'),
    log: join(logs, 'daemon.log'),
    job: agents ? join(agents, `${JOB_LABEL}.plist`) : null,
  };
}

// Create the state and log directories, open only to the user.
export function ensureDirs(paths: DaemonPaths): void {
  for (const dir of [paths.state, paths.logs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch {}
  }
}

import { DAEMON_START_TIMEOUT_MS, DAEMON_SHUTDOWN_TIMEOUT_MS, DAEMON_HANDSHAKE_TIMEOUT_MS, DAEMON_RELAUNCH_INTERVAL_MS, DAEMON_POLL_INTERVAL_MS, DAEMON_RECONNECT_RETRY_MS } from '../core/system-config.js';
// A daemon client: locate, handshake, start (see design/daemon.md,
// Connecting). MCP servers and CLI commands reach the daemon through this.
import net from 'node:net';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, realpathSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { daemonPaths, ensureDirs, type DaemonPaths } from './paths.js';
import { FileLock, isLocked } from './filelock.js';
import { Peer, RpcDisconnected, RpcFailure, ERR_SHUTTING_DOWN } from './jsonrpc.js';
import { loadJob, readJob, startJob, writeJob } from './launchd.js';
import { ownHello, type HelloResult } from './protocol.js';


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// How a client launches a daemon when none answers. The default spawns this
// same bundle; tests inject their own.
export type Launcher = (paths: DaemonPaths) => Promise<void>;

// This install: the node binary and the bundle the process is running. Node
// is named by its PATH entry when that is the running binary, since a package
// manager's versioned path (Homebrew's Cellar) goes stale on the next upgrade.
export function ownProgram(): { node: string; script: string } {
  let script = process.argv[1];
  try { script = realpathSync(script); } catch {}
  let node = process.execPath;
  try {
    const running = realpathSync(process.execPath);
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      const candidate = join(dir, 'node');
      if (dir && isAbsolute(dir) && existsSync(candidate) && realpathSync(candidate) === running) {
        node = candidate;
        break;
      }
    }
  } catch {}
  return { node, script };
}

// Launch the daemon detached from this process's host, so it outlives the
// client. While the login job is installed launchd is the one launcher.
const spawnDaemon: Launcher = async paths => {
  if (readJob(paths)) {
    await startJob(paths);
    return;
  }
  const { node, script } = ownProgram();
  const args = [script, 'daemon', 'run'];
  const log = openSync(paths.log, 'a', 0o600);
  try {
    const env = { ...process.env };
    if (paths.homeOverride) env.ASIDE_DAEMON_HOME = paths.homeOverride;
    else delete env.ASIDE_DAEMON_HOME;
    const child = spawn(node, args, { detached: true, cwd: paths.state, env, stdio: ['ignore', log, log] });
    child.on('error', () => {}); // a failed spawn surfaces as "did not start"
    child.unref();
  } finally {
    closeSync(log);
  }
};

export type DaemonStartup =
  | { action: 'started' | 'reused' }
  | { action: 'replaced'; previousPid: number };

export interface Connection {
  peer: Peer;
  hello: HelloResult;
  // Local connection metadata, not part of the daemon protocol.
  startup?: DaemonStartup;
}

// Connect and handshake; null when nothing answers.
export async function tryConnect(paths: DaemonPaths): Promise<Connection | null> {
  const socket = await new Promise<net.Socket | null>((done) => {
    const s = net.connect(paths.socket);
    s.once('connect', () => done(s));
    s.once('error', () => done(null));
  });
  if (!socket) return null;
  const peer = new Peer(socket);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A daemon that accepts but never answers is treated as not there.
    const hello = await Promise.race([
      peer.request<HelloResult>('hello', ownHello()),
      new Promise<never>((_, fail) => { timer = setTimeout(() => fail(new Error('hello timed out')), DAEMON_HANDSHAKE_TIMEOUT_MS); }),
    ]);
    return { peer, hello };
  } catch {
    peer.close();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Ask a daemon to shut down and wait for it to exit.
export async function shutdownDaemon(paths: DaemonPaths, conn: Connection): Promise<{ exited: boolean }> {
  try {
    await conn.peer.request('shutdown');
  } catch {
    // Already going, or gone.
  }
  const deadline = Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isLocked(paths.lifetimeLock)) {
      conn.peer.close();
      return { exited: true };
    }
    await sleep(DAEMON_POLL_INTERVAL_MS);
  }
  conn.peer.close();
  return { exited: false };
}

export interface ClientOptions {
  paths?: DaemonPaths;
  launcher?: Launcher;
}

export class DaemonClient {
  readonly paths: DaemonPaths;
  private launcher: Launcher;
  private conn: Connection | null = null;
  private connecting: Promise<Connection> | null = null;
  // Connections to a daemon that is shutting down: left open so requests
  // already in flight on them still get their answers.
  private retired = new Set<Connection>();
  private closed = false;
  private closeListeners = new Set<() => void>();

  constructor(options: ClientOptions = {}) {
    this.paths = options.paths ?? daemonPaths();
    this.launcher = options.launcher ?? spawnDaemon;
  }

  // Fires when the daemon connection drops.
  onDisconnect(cb: () => void): void {
    this.closeListeners.add(cb);
  }

  // The daemon this client reached, connecting first when needed.
  async hello(): Promise<HelloResult> {
    return (await this.connection()).hello;
  }

  // How this client reached its current daemon. Read after a successful request.
  get startup(): DaemonStartup | undefined {
    if (!this.conn) return undefined;
    return this.conn.startup ?? { action: 'reused' };
  }

  // Send one request. A read is repeated after a lost connection; a write
  // whose connection dropped has an unknown outcome and is reported, never
  // repeated. A request the daemon refused because it is shutting down did not
  // run, so it is sent again — to the daemon's successor — either way.
  async request<T = any>(method: string, params?: unknown, options: { read?: boolean } = {}): Promise<T> {
    const deadline = Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS + DAEMON_START_TIMEOUT_MS;
    let repeated = false;
    for (;;) {
      const conn = await this.connection();
      try {
        return await conn.peer.request<T>(method, params);
      } catch (e) {
        const refused = e instanceof RpcFailure && e.code === ERR_SHUTTING_DOWN;
        const lost = e instanceof RpcDisconnected;
        if (!refused && !lost) throw e;
        this.retire(conn);
        if (lost && !options.read) {
          throw new Error('The connection to the aside daemon was lost during this write, so its outcome is unknown. Check the record before repeating it.');
        }
        if (Date.now() >= deadline || (lost && repeated)) {
          throw new Error('The aside daemon is unavailable. Run `aside daemon status`.');
        }
        if (lost) repeated = true;
        else await sleep(DAEMON_RECONNECT_RETRY_MS); // the old daemon is still on its way out
      }
    }
  }

  close(): void {
    this.closed = true;
    this.closeListeners.clear();
    this.conn?.peer.close();
    this.conn = null;
    for (const conn of this.retired) conn.peer.close();
    this.retired.clear();
  }

  // Stop using a connection without closing it under requests still in flight.
  private retire(conn: Connection): void {
    if (this.conn === conn) this.conn = null;
    if (conn.peer.closed) return;
    this.retired.add(conn);
    conn.peer.onClose(() => this.retired.delete(conn));
  }

  private connection(): Promise<Connection> {
    if (this.conn && !this.conn.peer.closed) return Promise.resolve(this.conn);
    this.connecting ??= this.connect().then((conn) => {
      if (this.closed) {
        conn.peer.close();
        throw new Error('The aside daemon client was closed.');
      }
      this.conn = conn;
      conn.peer.onClose(() => {
        if (this.conn !== conn) return;
        this.conn = null;
        for (const cb of this.closeListeners) cb();
      });
      return conn;
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  // Locate, handshake, start.
  private async connect(): Promise<Connection> {
    ensureDirs(this.paths);
    const found = await tryConnect(this.paths);
    if (found) return this.settle(found);

    const lock = new FileLock(this.paths.startLock);
    if (!(await lock.acquireWait(DAEMON_START_TIMEOUT_MS + DAEMON_SHUTDOWN_TIMEOUT_MS))) {
      throw new Error('Cannot start the aside daemon: another process holds the start lock.');
    }
    try {
      const again = await tryConnect(this.paths);
      if (again) return await this.settle(again, lock);
      await this.refreshJob();
      return await this.launch();
    } finally {
      lock.release();
    }
  }

  // Launch a daemon and wait for it to answer. A launch can lose to a daemon
  // still exiting, so it is repeated until one answers or time runs out.
  private async launch(previousPid?: number): Promise<Connection> {
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
    let launched = 0;
    while (Date.now() < deadline) {
      if (Date.now() - launched >= DAEMON_RELAUNCH_INTERVAL_MS) {
        launched = Date.now();
        await this.launcher(this.paths);
      }
      const conn = await tryConnect(this.paths);
      if (conn) return {
        ...this.accept(conn),
        startup: previousPid === undefined ? { action: 'started' } : { action: 'replaced', previousPid },
      };
      await sleep(DAEMON_POLL_INTERVAL_MS);
    }
    throw new Error(`The aside daemon did not start. See its log: ${this.paths.log}`);
  }

  // Apply the version rules to a daemon that answered. `held` is the start
  // lock when the caller already holds it.
  private async settle(conn: Connection, held?: FileLock): Promise<Connection> {
    const mine = ownHello();
    if (mine.build.builtAt <= conn.hello.build.builtAt) return this.accept(conn);

    // This build is newer: replace the daemon, under the start lock.
    const lock = held ?? new FileLock(this.paths.startLock);
    if (!held && !(await lock.acquireWait(DAEMON_START_TIMEOUT_MS + DAEMON_SHUTDOWN_TIMEOUT_MS))) return this.accept(conn);
    try {
      conn.peer.close();
      const current = await tryConnect(this.paths);
      if (!current) return await this.launch();
      if (mine.build.builtAt <= current.hello.build.builtAt) return this.accept(current);
      const { exited } = await shutdownDaemon(this.paths, current);
      if (!exited) {
        const still = await tryConnect(this.paths);
        if (!still) throw new Error('The aside daemon is not responding. Run `aside daemon stop`, then retry.');
        return this.accept(still);
      }
      await this.refreshJob();
      return await this.launch(current.hello.pid);
    } finally {
      if (!held) lock.release();
    }
  }

  // Use the running daemon when both sides run the same software version.
  private accept(conn: Connection): Connection {
    const mine = ownHello();
    if (conn.hello.build.version === mine.build.version) return conn;
    conn.peer.close();
    throw new Error(`The aside daemon runs version ${conn.hello.build.version}, but this session runs ${mine.build.version}. Restart the session or run \`aside daemon stop\`, then retry.`);
  }

  // Keep the login job current: point it at this install when it was written
  // by an older build, or when the install it names is gone.
  private async refreshJob(): Promise<void> {
    const job = readJob(this.paths);
    const mine = ownHello();
    if (!job) return;
    if (job.builtAt >= mine.build.builtAt && existsSync(job.program[1] ?? '')) return;
    const { node, script } = ownProgram();
    writeJob(this.paths, node, script, mine.build.builtAt);
    await loadJob(this.paths);
  }
}

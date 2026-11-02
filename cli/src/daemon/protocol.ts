// The daemon protocol's shapes (see cli/spec.md, Daemon). `hello` and
// `shutdown` are the fixed core: they keep their shape across releases,
// so any client can identify and replace any daemon.
import { BUILT_AT, VERSION } from '../version.js';

export interface Build {
  version: string;
  builtAt: number;
}

export interface Hello {
  build: Build;
}

export interface HelloResult extends Hello {
  pid: number;
}

export interface Status extends HelloResult {
  connections: number;
  tabs: number;
  known: string[];
  loaded: string[];
  // Connected clients that have used each instance; optional for older daemons.
  sessions?: Record<string, number>;
  graphqlLogging?: {queuedBytes: number; dropped: number; errors: number};
}

export interface StopResult {
  stopped: boolean;
  connections: number;
  tabs: number;
  instances: string[];
}

export interface KnownEditResult {
  known: string[];
  // Canonical requested paths whose registration changed; absent on older daemons.
  changed?: string[];
}

export interface DiagnosticCleanupResult {
  usage: {files: number; collections: number};
  automation: {runs: number};
}

export function ownHello(): Hello {
  return { build: { version: VERSION, builtAt: BUILT_AT } };
}

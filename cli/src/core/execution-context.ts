import type {ExecutionConfig} from './automation.js';

/** Published by the instance owner and safe to send to the execution worker. */
export interface ExecutionContextSnapshot {
  config: ExecutionConfig;
  cwd: string;
  revision: string;
  error?: string;
}

/** Resolve a captured generation without looking at its source file again. */
export function resolveExecutionContext(snapshot: ExecutionContextSnapshot | undefined): {config: ExecutionConfig; cwd: string} {
  if (!snapshot) throw new Error('Lifecycle execution context is unavailable. Request published instance settings from the Aside daemon.');
  if (snapshot.error) throw new Error(snapshot.error);
  return {config: snapshot.config, cwd: snapshot.cwd};
}

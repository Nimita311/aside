import {statSync} from 'node:fs';

/** The destination can change after publication; check it at actual use. */
export function assertExecutionCwd(cwd: string): void {
  if (!statSync(cwd).isDirectory()) throw new Error(`Execution cwd is not a directory: ${cwd}`);
}

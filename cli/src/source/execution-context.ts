import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {parseConfig} from '../core/parser.js';
import type {ExecutionContextSnapshot} from '../core/execution-context.js';
import {assertExecutionCwd} from '../runtime/execution-cwd.js';

/** Lifecycle source loading owns reads of the instance's execution settings. */
export function readExecutionContextSnapshot(root: string): ExecutionContextSnapshot {
  const file = join(root, '.aside');
  let source = '', error: string | undefined;
  try {source = readFileSync(file, 'utf8');}
  catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') error = `Cannot read execution config: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  const parsed = parseConfig(source);
  if (!error && parsed.issues.some(issue => issue.severity === 'error')) error = `Invalid execution config: ${parsed.issues.map(issue => issue.message).join('; ')}`;
  const config = parsed.value.execution ?? {};
  const cwd = resolve(root, config.cwd ?? '.');
  if (!error) {
    try {assertExecutionCwd(cwd);}
    catch (cause) {error = `Invalid execution cwd: ${cause instanceof Error ? cause.message : String(cause)}`;}
  }
  return {config, cwd,
    revision: createHash('sha256').update(source).update('\0').update(error ?? '').digest('hex'), ...(error ? {error} : {})};
}

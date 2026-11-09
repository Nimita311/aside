import {resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import {readInstanceRecordResult} from '../src/core/instance.js';
import {readExecutionContextSnapshot} from '../src/source/execution-context.js';
import {type ExecutionContextSnapshot} from '../src/core/execution-context.js';
import type {InstanceRecord, ParseResult} from '../src/core/types.js';

// Fixture publication is explicit. Provider callbacks only read these maps;
// a query can never turn a missing fixture into an implicit source-file read.
export function lifecycleMetadataFixture(...paths: string[]) {
  const records = new Map<string, ParseResult<InstanceRecord>>();
  const contexts = new Map<string, ExecutionContextSnapshot>();
  const publish = (path: string) => {
    const root = resolve(path);
    const record = readInstanceRecordResult(root), context = readExecutionContextSnapshot(root);
    for (const key of new Set([root, realpathSync(root)])) {records.set(key, record); contexts.set(key, context);}
  };
  for (const path of paths) publish(path);
  const loadedInstance = (path: string) => records.get(resolve(path));
  const executionContext = (path: string) => contexts.get(resolve(path));
  const instanceRecord = async (path: string) => loadedInstance(path);
  return {publish, loadedInstance, executionContext, instanceRecord};
}

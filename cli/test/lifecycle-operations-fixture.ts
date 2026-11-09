import {isAsideDir, readManifestResult} from '../src/core/instance.js';
import {instanceKey} from '../src/daemon/host.js';
import {createInstanceSource} from '../src/daemon/instance-operations.js';
import type {InstanceBackend} from '../src/mcp/instance-session.js';
import type {InstanceRecord, ParseIssue, ParseResult} from '../src/core/types.js';
import {InstanceOperationError} from '../src/core/instance-operation-error.js';

/** Explicit in-process source owner for session tests. Production session code
 * cannot acquire these source operations by omitting a daemon capability. */
export interface FixtureBackend extends Omit<InstanceBackend, 'admitInstance' | 'createInstance'> {
  issues(path: string): Promise<ParseIssue[]>;
  instanceRecord?(path: string): Promise<ParseResult<InstanceRecord> | undefined>;
  created?(path: string, options?: {partial?: boolean}): Promise<ParseIssue[]>;
}

export function lifecycleOperationsFixture<T extends FixtureBackend>(backend: T): T & Pick<InstanceBackend, 'admitInstance' | 'createInstance'> {
  return {...backend,
    admitInstance: async path => {
      if (!isAsideDir(path)) {
        const error = readManifestResult(path).issues.find(issue => issue.code === 'read_error');
        if (error) throw new Error(error.message);
        throw new InstanceOperationError('NOT_INSTANCE', `Not an aside instance (no aside.md manifest): ${path}`);
      }
      const canonical = instanceKey(path), issues = await backend.issues(canonical);
      const record = await backend.instanceRecord?.(canonical);
      if (!record) throw new Error(`Lifecycle-provided instance metadata is unavailable for ${canonical}.`);
      return {path: canonical, record, issues};
    },
    createInstance: input => createInstanceSource(input, {
      created: (path, options) => backend.created ? backend.created(path, options) : backend.issues(path),
      instanceRecord: async path => backend.instanceRecord?.(path),
    }),
  };
}

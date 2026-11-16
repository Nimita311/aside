import {basename, join, resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import {init, type InitOptions, type InitResult} from '../source/bootstrap.js';
import {isAsideDir, readInstanceRecordResult} from '../core/instance.js';
import type {InstanceRecord, ParseIssue, ParseResult} from '../core/types.js';
import {formatInstanceEntry} from '../core/text.js';
import type {MutationChange} from '../source/mutation-result.js';
import {InstanceOperationError} from '../core/instance-operation-error.js';
import {errorMessage} from '../core/error.js';
import {canonicalPath} from '../core/worktree.js';

export interface InstanceAdmissionResult {
  path: string;
  record: ParseResult<InstanceRecord>;
  issues: ParseIssue[];
}

export interface InstanceCreationResult extends InstanceAdmissionResult {
  admitted: boolean;
  changes: MutationChange[];
  tutorialProjectId?: string;
  error?: string;
}

export interface InstanceCreationOwner {
  created(path: string, options?: {partial?: boolean}): Promise<ParseIssue[]>;
  instanceRecord(path: string): Promise<ParseResult<InstanceRecord> | undefined>;
}

/** CLI bootstrap leaves registration and session selection unchanged. Every
 * confirmed write is still published by the owner, including a partial init. */
export function bootstrapInstanceSource(input: InitOptions & {path: string}, publish: (path: string) => void): InitResult {
  const path = resolve(input.path);
  let changed = false, failed = false, failure: unknown, result: InitResult | undefined;
  try {result = init(path, input, () => {changed = true;});}
  catch (error) {failed = true; failure = error;}
  if (changed) {
    // Preserve owner notification even if the saved root has disappeared.
    const writtenRoot = canonicalPath(path);
    try {publish(writtenRoot);}
    catch (error) {
      if (!failed) throw new Error(`Instance files created; loaded source repair is pending: ${errorMessage(error)}`, {cause: error});
      throw new Error(`${errorMessage(failure)}\nLoaded source repair is pending: ${errorMessage(error)}`, {cause: failure});
    }
  }
  if (failed) throw failure;
  return result!;
}

/** Source bootstrap belongs to the daemon owner, including durable receipts if
 * initialization or subsequent admission fails. Session selection stays outside. */
export async function createInstanceSource(input: InitOptions & {path: string}, owner: InstanceCreationOwner): Promise<InstanceCreationResult> {
  const path = resolve(input.path);
  if (isAsideDir(path)) throw new InstanceOperationError('ALREADY_INSTANCE', `Already an aside instance: ${path}`);
  const changes: MutationChange[] = [], issues: ParseIssue[] = [];
  let bootstrap: ParseResult<InstanceRecord> | undefined;
  const record = () => bootstrap ??= readInstanceRecordResult(path);
  const label = () => {
    const parsed = record();
    return formatInstanceEntry(path, {value: parsed.value.manifest, issues: parsed.issues});
  };
  const incomplete = (error: string): InstanceCreationResult => ({path, record: record(), issues,
    changes, admitted: false, error});
  const createdFile = (file: string) => {
    const kind = file === 'aside.md' ? 'instance' : /^(projects|actions)\/\d{4}\/[^/]+\.md$/.test(file)
      ? file.startsWith('projects/') ? 'project' : 'action' : file.endsWith('/index.yaml') ? 'index' : 'file';
    const id = kind === 'instance' ? record().value.manifest.id : kind === 'project' || kind === 'action' ? basename(file, '.md') : file;
    changes.push({kind, id, effect: 'CREATED', path: join(path, file), ...(kind === 'instance' ? {fields: ['manifest']} : {})});
  };
  let result: ReturnType<typeof init>;
  try {result = init(path, input, createdFile);}
  catch (error) {
    if (!isAsideDir(path)) throw new Error(`Cannot create instance: ${errorMessage(error)}`);
    let repair = '';
    try {issues.push(...await owner.created(path, {partial: true}));}
    catch (failure) {repair = `\nLoaded source repair is pending: ${errorMessage(failure)}`;}
    return incomplete(`Instance files created: ${label()}\nInitialization incomplete: ${errorMessage(error)}${repair}\nDaemon registration: not attempted.`);
  }
  try {issues.push(...await owner.created(path));}
  catch (error) {
    return incomplete(`Created: ${label()}\nDaemon registration and initial load: unconfirmed — ${errorMessage(error)}\nActivation: not completed.`);
  }
  try {
    const published = await owner.instanceRecord(path);
    if (!published) throw new Error(`Lifecycle-provided instance metadata is unavailable for ${path}. Query through the Aside daemon.`);
    return {path: realpathSync(path), record: published, issues, changes, admitted: true, tutorialProjectId: result.tutorial?.projectId};
  } catch (error) {
    return incomplete(`Created: ${label()}\nLifecycle metadata and activation: unconfirmed — ${errorMessage(error)}`);
  }
}

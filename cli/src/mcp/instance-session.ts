import { resolve } from 'node:path';
import type { InitOptions } from '../source/bootstrap.js';
import { isInstanceId } from '../core/identity.js';
import type { InstanceRecord, ParseIssue, ParseResult } from '../core/types.js';
import {formatIssueSummary} from './format.js';
import {formatInstanceLine, formatScalar} from '../core/text.js';
import { InstanceRegistry, type InstanceSelection } from './instance-registry.js';
import { validateToolArgs } from './schemas.js';
import type { MutationChange } from '../source/mutation-result.js';
import type {InstanceAdmissionResult, InstanceCreationResult} from '../daemon/instance-operations.js';
import {InstanceOperationError} from '../core/instance-operation-error.js';

type InstanceRecordReader = (path: string) => ParseResult<InstanceRecord>;

export interface InstanceBackend {
  knownInstances(): Promise<string[]>;
  admitInstance(path: string): Promise<InstanceAdmissionResult>;
  createInstance(input: InitOptions & {path: string}): Promise<InstanceCreationResult>;
  family?(path: string): string;
  reconcile?(): void;
}

export interface InstanceInfo {
  id: string;
  name?: string;
  description?: string;
  path: string;
  active: boolean;
  workspace: boolean;
}

export interface InstanceReceipt {
  instance: InstanceInfo;
  created: boolean;
  activated: boolean;
  tutorialProjectId?: string;
  error?: string;
  changes?: MutationChange[];
}

export interface InstanceSessionState extends InstanceSelection {
  configIssues: ParseIssue[];
  discovery: boolean;
  cwd: string;
}

// Session operations for one GraphQL daemon request. Only the MCP session
// retains selection; the daemon receives and returns it explicitly so reconnects
// never share another session's default.
export class InstanceSession {
  readonly diagnostics: ParseIssue[];
  private readonly configNote: string;
  private readonly metadata = new Map<string, ParseResult<InstanceRecord>>();

  constructor(
    readonly registry: InstanceRegistry,
    private backend: InstanceBackend,
    private configIssues: ParseIssue[] = [],
    private discovery = true,
    private cwd = process.cwd(),
  ) {
    this.diagnostics = [...configIssues];
    const summary = formatIssueSummary(configIssues, 5, 'from the .aside config');
    this.configNote = summary ? `\n\n${summary}` : '';
  }

  state(): InstanceSessionState {
    return { ...this.registry.selection(), configIssues: this.configIssues, discovery: this.discovery, cwd: this.cwd };
  }

  // System diagnostics need the launch directory without inspecting or pruning content selection.
  get workingDirectory(): string { return this.cwd; }

  requireInstance(): string {
    const active = this.registry.activeInstance;
    if (active) return active;
    const known = this.registry.all();
    const why = this.discovery
      ? 'Searched the current directory and its immediate children for an aside.md manifest.'
      : 'Auto-discovery is off (`discovery: false` in `.aside`) and the config lists no instances, so nothing was scanned.';
    throw new Error(known.length
      ? `No active aside instance. Select one with selectInstance:\n${known.map(p => `  ${this.metadata.has(p) ? this.formatInfo(this.info(p, path => this.metadata.get(path)!)) : formatScalar(p)}`).join('\n')}${this.configNote}`
      : `No active aside instance. ${why}\nCall instances for the daemon's other known instances. Use selectInstance to choose an existing instance, or createInstance to make a new one.${this.configNote}`);
  }

  private addIssues(issues: ParseIssue[]): void {
    for (const issue of issues) {
      if (!this.diagnostics.some(existing => JSON.stringify(existing) === JSON.stringify(issue))) this.diagnostics.push(issue);
    }
  }

  private observedRecord(path: string): ParseResult<InstanceRecord> {
    const record = this.metadata.get(path);
    if (!record) throw new Error(`Lifecycle-provided instance metadata is unavailable for ${path}. Query through the Aside daemon.`);
    return record;
  }

  private info(path: string, readInstance: InstanceRecordReader = path => this.observedRecord(path)): InstanceInfo {
    const record = readInstance(path);
    this.addIssues(record.issues);
    const manifest = record.value.manifest;
    return { id: manifest.id, name: manifest.name, description: manifest.description,
      path, active: path === this.registry.activeInstance, workspace: this.registry.selection().workspace.includes(path) };
  }

  private formatInfo(info: InstanceInfo): string {
    const line = formatInstanceLine(info.path, {id: info.id, name: info.name, description: info.description});
    const error = this.metadata.get(info.path)?.issues.find(issue => issue.code === 'read_error');
    return error ? `${line}\n    manifest: ${formatScalar(error.message)}` : line;
  }

  async activeInstance(readInstance: InstanceRecordReader): Promise<InstanceInfo | null> {
    this.backend.reconcile?.();
    const path = this.registry.activeInstance;
    return path ? this.info(path, readInstance) : null;
  }

  async instances(readInstance: InstanceRecordReader): Promise<InstanceInfo[]> {
    const known = await this.backend.knownInstances();
    this.backend.reconcile?.();
    const rows = this.registry.catalogue(known).flatMap(row => {
      const record = readInstance(row.path);
      this.addIssues(record.issues);
      if (record.issues.some(issue => issue.code === 'read_error')) return [];
      return [this.info(row.path, () => record)];
    });
    const identities = new Map<string, string[]>();
    for (const row of rows) if (isInstanceId(row.id)) identities.set(row.id, [...(identities.get(row.id) ?? []), row.path]);
    for (const [id, paths] of identities) {
      if (new Set(paths.map(path => this.backend.family?.(path) ?? path)).size > 1) this.addIssues([{
        severity: 'warning', code: 'instance_id_conflict', file: 'aside.md', field: 'id',
        message: `Duplicate instance ID detected: ${formatScalar(id)} is shared by ${paths.map(formatScalar).join(', ')}. Give each distinct instance a different hostname-safe ID before syncing them separately.`,
      }]);
    }
    return rows;
  }

  async selectInstance(pathInput: string): Promise<InstanceReceipt> {
    const path = resolve(this.cwd, pathInput);
    let admitted: InstanceAdmissionResult;
    try {admitted = await this.backend.admitInstance(path);}
    catch (error) {
      if (error instanceof InstanceOperationError && error.reason === 'NOT_INSTANCE') {
        throw new Error(`${error.message}\nUse createInstance to make a new one here.`);
      }
      throw error;
    }
    this.addIssues(admitted.issues);
    const previous = this.registry.selection();
    try {
      this.metadata.set(admitted.path, admitted.record);
      this.registry.activateAdmitted(admitted.path);
      return { instance: this.info(this.registry.activeInstance!), created: false, activated: true };
    } catch (error) {this.registry.restore(previous); throw error;}
  }

  async createInstance(input: InitOptions & { path: string }): Promise<InstanceReceipt> {
    input = validateToolArgs('create_instance', input) as InitOptions & { path: string };
    const path = resolve(this.cwd, input.path);
    const recovery = () => {
      const active = this.registry.activeInstance;
      const label = active ? this.metadata.has(active) ? this.formatInfo(this.info(active)) : formatScalar(active) : 'none';
      return `Active selection: ${label}.\nRecover with selectInstance using path: ${formatScalar(path)}. The instance files already exist; do not repeat createInstance.`;
    };
    let result: InstanceCreationResult;
    try {result = await this.backend.createInstance({...input, path});}
    catch (error) {
      if (error instanceof InstanceOperationError && error.reason === 'ALREADY_INSTANCE') {
        throw new Error(`${error.message}\nUse selectInstance to activate it.`);
      }
      throw error;
    }
    this.addIssues(result.issues);
    if (!result.admitted) {
      const failure = `${result.error ?? 'Lifecycle admission did not complete.'}\n${recovery()}`;
      return {instance: this.info(result.path, () => result.record), created: true, activated: false, error: failure, changes: result.changes};
    }
    const previous = this.registry.selection();
    try {
      this.metadata.set(result.path, result.record);
      this.registry.activateAdmitted(result.path);
      return { instance: this.info(this.registry.activeInstance!), created: true, activated: true, tutorialProjectId: result.tutorialProjectId, changes: result.changes };
    } catch (error) {
      this.registry.restore(previous);
      const failure = `Created instance ${formatScalar(result.path)}\nLifecycle metadata and activation: unconfirmed — ${(error as Error).message}\n${recovery()}`;
      return {instance: this.info(result.path, () => result.record), created: true, activated: false, error: failure, changes: result.changes};
    }
  }
}

import { basename, join, resolve } from 'node:path';
import { init, type InitOptions } from '../commands/init.js';
import { isAsideDir, readManifestResult } from '../core/instance.js';
import { isInstanceId } from '../core/identity.js';
import { instanceFamily } from '../core/worktree.js';
import type { ParseIssue } from '../core/types.js';
import { formatIssueSummary, formatInstanceEntry, formatScalar } from './format.js';
import { InstanceRegistry, type InstanceSelection } from './instance-registry.js';
import { validateToolArgs } from './schemas.js';
import type { MutationChange } from './tools/mutation-result.js';

export interface InstanceBackend {
  knownInstances(): Promise<string[]>;
  issues(path: string): Promise<ParseIssue[]>;
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
  receipt: string;
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

// Session operations are shared by legacy MCP tools and the GraphQL daemon
// request. Only the MCP session retains selection; the daemon receives and
// returns it explicitly so reconnects never share another session's default.
export class InstanceSession {
  readonly diagnostics: ParseIssue[];
  private readonly configNote: string;

  constructor(
    readonly registry: InstanceRegistry,
    private backend: InstanceBackend,
    private configIssues: ParseIssue[] = [],
    private discovery = true,
    private graphql = false,
    private cwd = process.cwd(),
  ) {
    this.diagnostics = [...configIssues];
    const summary = formatIssueSummary(configIssues, 5, 'from the .aside config');
    this.configNote = summary ? `\n\n${summary}` : '';
  }

  state(): InstanceSessionState {
    return { ...this.registry.selection(), configIssues: this.configIssues, discovery: this.discovery, cwd: this.cwd };
  }

  private name(operation: 'select' | 'create' | 'list'): string {
    return this.graphql
      ? { select: 'selectInstance', create: 'createInstance', list: 'instances' }[operation]
      : { select: 'select_instance', create: 'create_instance', list: 'list_instances' }[operation];
  }

  requireInstance(): string {
    const active = this.registry.activeInstance;
    if (active) return active;
    const known = this.registry.all();
    const why = this.discovery
      ? 'Searched the current directory and its immediate children for an aside.md manifest.'
      : 'Auto-discovery is off (`discovery: false` in `.aside`) and the config lists no instances, so nothing was scanned.';
    throw new Error(known.length
      ? `No active aside instance. Select one with ${this.name('select')}:\n${known.map(p => `  ${formatInstanceEntry(p)}`).join('\n')}${this.configNote}`
      : `No active aside instance. ${why}\nCall ${this.name('list')} for the daemon's other known instances. Use ${this.name('select')} to choose an existing instance, or ${this.name('create')} to make a new one.${this.configNote}`);
  }

  private addIssues(issues: ParseIssue[]): void {
    for (const issue of issues) {
      if (!this.diagnostics.some(existing => JSON.stringify(existing) === JSON.stringify(issue))) this.diagnostics.push(issue);
    }
  }

  private info(path: string): InstanceInfo {
    const manifest = readManifestResult(path);
    this.addIssues(manifest.issues);
    return { id: manifest.value.id, name: manifest.value.name, description: manifest.value.description,
      path, active: path === this.registry.activeInstance, workspace: this.registry.selection().workspace.includes(path) };
  }

  private async issueNote(path: string): Promise<string> {
    const issues = await this.backend.issues(path);
    this.addIssues(issues);
    const summary = formatIssueSummary(issues, 5, this.graphql
      ? 'data loaded best-effort; query activeInstance { validation { passed checks { name passed details } } } for detail'
      : undefined);
    return summary ? `\n\n${summary}` : '';
  }

  async activeInstance(inspect = true): Promise<InstanceInfo | null> {
    this.registry.all();
    const path = this.registry.activeInstance;
    if (!path) return null;
    if (inspect) await this.issueNote(path);
    return this.info(path);
  }

  async instances(inspect = true): Promise<InstanceInfo[]> {
    const listing = this.registry.catalogue(await this.backend.knownInstances());
    const rows = listing.map(row => this.info(row.path));
    const identities = new Map<string, string[]>();
    for (const row of rows) if (isInstanceId(row.id)) identities.set(row.id, [...(identities.get(row.id) ?? []), row.path]);
    for (const [id, paths] of identities) {
      if (new Set(paths.map(instanceFamily)).size > 1) this.addIssues([{
        severity: 'warning', code: 'instance_id_conflict', file: 'aside.md', field: 'id',
        message: `Duplicate instance ID detected: ${formatScalar(id)} is shared by ${paths.map(formatScalar).join(', ')}. Give each distinct instance a different hostname-safe ID before syncing them separately.`,
      }]);
    }
    const active = this.registry.activeInstance;
    if (inspect && active && !readManifestResult(active).issues.some(issue => issue.code === 'read_error')) await this.issueNote(active);
    return rows;
  }

  async listReceipt(): Promise<string> {
    this.diagnostics.splice(0, this.diagnostics.length, ...this.configIssues);
    const rows = await this.instances();
    const active = this.registry.activeInstance;
    let text = active ? `Active: ${formatInstanceEntry(active)}` : 'No active aside instance. Use select_instance with a listed path, or create_instance to make one.';
    text += '\n\nIn this workspace means included by this session\'s directory discovery, .aside configuration or --dir.';
    for (const [workspace, label] of [[true, 'In this workspace'], [false, 'Other known instances']] as const) {
      const group = rows.filter(row => row.workspace === workspace);
      text += `\n\n${label}:\n` + (group.length ? group.map(row => `  ${row.active ? '[active] ' : ''}${formatInstanceEntry(row.path)}`).join('\n') : '  none');
    }
    for (const issue of this.diagnostics.filter(issue => issue.code === 'instance_id_conflict')) text += `\n\n${issue.message}`;
    const summary = formatIssueSummary(this.diagnostics.filter(issue => !this.configIssues.includes(issue) && issue.code !== 'instance_id_conflict'));
    return text + (summary ? `\n\n${summary}` : '') + this.configNote;
  }

  async selectInstance(pathInput: string): Promise<InstanceReceipt> {
    const path = resolve(this.cwd, pathInput);
    if (!isAsideDir(path)) {
      await this.backend.knownInstances().catch(() => []);
      this.registry.all();
      const error = readManifestResult(path).issues.find(issue => issue.code === 'read_error');
      if (error) throw new Error(error.message);
      throw new Error(`Not an aside instance (no aside.md manifest): ${path}\nUse ${this.name('create')} to make a new one here.`);
    }
    const note = await this.issueNote(path);
    this.registry.activate(path);
    const canonical = this.registry.activeInstance!;
    return { instance: this.info(canonical), created: false, activated: true,
      receipt: `Active: ${formatInstanceEntry(canonical)}\nRegistered with the daemon for future listings. This session's selection is independent; the next session uses --dir, .aside default, workspace discovery and a sole workspace candidate, in that order.${note}${this.configNote}` };
  }

  async createInstance(input: InitOptions & { path: string }): Promise<InstanceReceipt> {
    input = validateToolArgs('create_instance', input) as InitOptions & { path: string };
    const path = resolve(this.cwd, input.path);
    if (isAsideDir(path)) throw new Error(`Already an aside instance: ${path}\nUse ${this.name('select')} to activate it.`);
    const recovery = () => `Active selection: ${this.registry.activeInstance ? formatInstanceEntry(this.registry.activeInstance) : 'none'}.\nRecover with ${this.name('select')} using path: ${formatScalar(path)}. The instance files already exist; do not repeat ${this.name('create')}.`;
    const changes: MutationChange[] = [];
    const createdFile = (file: string) => {
      const kind = file === 'aside.md' ? 'instance' : /^(projects|actions)\/\d{4}\/[^/]+\.md$/.test(file)
        ? file.startsWith('projects/') ? 'project' : 'action' : file.endsWith('/index.yaml') ? 'index' : 'file';
      const id = kind === 'instance' ? this.info(path).id : kind === 'project' || kind === 'action' ? basename(file, '.md') : file;
      changes.push({kind, id, effect: 'CREATED', path: join(path, file), ...(kind === 'instance' ? {fields: ['manifest']} : {})});
    };
    const incomplete = (receipt: string): InstanceReceipt => ({ receipt, instance: this.info(path), created: true, activated: false, error: receipt, changes });
    let result: ReturnType<typeof init>;
    try { result = init(path, input, createdFile); }
    catch (error) {
      if (isAsideDir(path)) return incomplete(`Instance files created: ${formatInstanceEntry(path)}\nInitialization incomplete: ${(error as Error).message}\nDaemon registration: not attempted.\n${recovery()}`);
      throw new Error(`Cannot create instance: ${(error as Error).message}`);
    }
    try { this.addIssues(await this.backend.issues(path)); }
    catch (error) { return incomplete(`Created: ${formatInstanceEntry(path)}\nDaemon registration and initial load: unconfirmed — ${(error as Error).message}\nActivation: not completed.\n${recovery()}`); }
    this.registry.activate(path);
    let receipt = `Created and activated: ${formatInstanceEntry(path)}\nRegistered with the daemon for future listings. The next session selects from its own workspace using --dir, .aside default, directory discovery and a sole workspace candidate.`;
    if (result.tutorial) receipt += `\n\nTutorial content created. Read the getting-started project (${result.tutorial.projectId}) — a guided tour of how entries, projects, and actions link together — and walk the user through it, starting with the starter actions waiting in the backlog.`;
    return { receipt, instance: this.info(this.registry.activeInstance!), created: true, activated: true, tutorialProjectId: result.tutorial?.projectId, changes };
  }
}

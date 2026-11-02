import { dirname, join } from 'node:path';
import { GraphQLError } from 'graphql';
import { catalogFor, readExecutionContext, type ModelCatalogSnapshot } from '../automation/models.js';
import { compileSchedule } from '../automation/schedule.js';
import { validateDefinition, type AutomationDeclarations, type AutomationDefinition } from '../core/automation.js';
import { AUTOMATION_DEFAULT_TIMEOUT } from '../core/system-config.js';
import type { RecordNode } from './query.js';
import type { ParseIssue } from '../core/types.js';
import type { AutomationJobRuntime, AutomationLogPage, AutomationLogStream, AutomationRunRuntime, AutomationRuntimeSnapshot } from './automation-runtime.js';

export interface AutomationOwner {
  declarations?: AutomationDeclarations;
  projectId?: string;
  filePath?: string;
}
export interface AutomationLogOwner {
  projectId?: string;
  actionKey?: string;
  templateId?: string;
}
export interface AutomationPageInput {
  where?: { name?: string | null } | null;
  offset?: number | null;
  limit?: number | null;
}
export interface AutomationRunPageInput {
  where?: {
    id?: string | null;
    name?: string | null;
    status?: AutomationRunRuntime['status'][] | null;
  } | null;
  offset?: number | null;
  limit?: number | null;
}
export interface AutomationPage<T> {
  nodes: T[];
  offset: number;
  count: number;
  totalCount: number;
}
export type StoredAutomationPrompt = Extract<AutomationDefinition['run'], {model: string}>['prompt'];
export type AutomationRunDefinitionNode =
  | {script: string; args?: string[]}
  | {model: string; prompt: () => unknown};
export interface AutomationNode {
  name: string;
  schedule: AutomationDefinition['schedule'] | null;
  run: AutomationRunDefinitionNode | null;
  enabled: boolean | null;
  timeout: string | null;
  overlap: AutomationDefinition['overlap'] | null;
  next: () => Promise<string | null>;
  running: () => Promise<boolean | null>;
  log: (input: AutomationRunPageInput) => Promise<AutomationPage<AutomationRunNode>>;
}
export interface AutomationRunNode extends Omit<AutomationRunRuntime, 'key' | 'definedIn' | 'scope' | 'projectId'> {
  filePath: string;
  action: () => RecordNode | null;
  automation: () => Promise<AutomationNode | null>;
  output: (input: { stream: AutomationLogStream; offset?: number | null; limit?: number | null }) => Promise<AutomationLogPage | null>;
}
export interface AutomationViewOptions {
  runtime: () => Promise<AutomationRuntimeSnapshot>;
  output?: (runId: string, stream: AutomationLogStream, offset: number, limit: number) => Promise<AutomationLogPage | null>;
  diagnostics: ParseIssue[];
  signal?: AbortSignal;
  instanceOwner?: () => AutomationOwner;
  projectOwner?: (id: string) => AutomationOwner | null;
  action?: (id: string) => RecordNode | undefined;
  actionAutomation?: (node: RecordNode) => AutomationNode | null;
  resolveArtifactPrompt?: (prompt: StoredAutomationPrompt, owner: AutomationOwner, name: string) => unknown;
}

function page<T>(nodes: T[], input: { offset?: number | null; limit?: number | null }): AutomationPage<T> {
  const offset = input.offset ?? 0, limit = input.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new GraphQLError('offset must be a nonnegative safe integer.');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new GraphQLError('limit must be between 1 and 100.');
  const selected = nodes.slice(offset, offset + limit);
  return { nodes: selected, offset, count: selected.length, totalCount: nodes.length };
}

function inOwner(value: { scope: string; projectId?: string; key?: string; templateId?: string }, owner: AutomationLogOwner): boolean {
  if (owner.actionKey !== undefined) {
    return value.scope === 'action' && (value.key === owner.actionKey || owner.templateId !== undefined && value.templateId === owner.templateId);
  }
  return owner.projectId === undefined ? value.scope === 'instance'
    : value.scope === 'project' && value.projectId === owner.projectId;
}

function inInstance(value: { key: string; definedIn: string; name: string }, root: string): boolean {
  try {
    const key = JSON.parse(value.key);
    return Array.isArray(key) && key.length === 3 && key[0] === root && key[1] === value.definedIn && key[2] === value.name;
  } catch { return false; }
}

/** Typed declarations and passive observations, scoped to one request's instance. */
export class AutomationView {
  constructor(readonly root: string, private readonly options: AutomationViewOptions) {}

  private definition(owner: AutomationOwner, name: string, declaration: unknown): AutomationDefinition | null {
    try {
      const definition = validateDefinition(declaration);
      compileSchedule(definition.schedule);
      return definition;
    } catch (error) {
      this.options.diagnostics.push({ severity: 'error', code: 'invalid_automation',
        field: `automations.${name}`, ...(owner.filePath ? { file: owner.filePath } : {}),
        message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  private node(owner: AutomationOwner, name: string, declaration: unknown): AutomationNode {
    const definition = this.definition(owner, name, declaration);
    const execution = definition?.run;
    let run: AutomationRunDefinitionNode | null = execution && 'script' in execution ? execution : null;
    if (execution && 'prompt' in execution) {
      const storedPrompt = execution.prompt;
      let resolved = false, artifact: unknown;
      run = {...execution, prompt: () => {
        this.options.signal?.throwIfAborted();
        if (!resolved) {
          artifact = this.options.resolveArtifactPrompt?.(storedPrompt, owner, name) ?? null;
          resolved = true;
        }
        return artifact;
      }};
    }
    let observation: Promise<AutomationJobRuntime | undefined> | undefined;
    const observe = () => {
      this.options.signal?.throwIfAborted();
      return observation ??= (async () => {
        const snapshot = await this.options.runtime();
        this.options.signal?.throwIfAborted();
        return snapshot.available ? snapshot.jobs.find(job => inInstance(job, this.root) && job.name === name && inOwner(job, owner)) : undefined;
      })();
    };
    return {
      name, schedule: definition?.schedule ?? null, run,
      enabled: definition ? definition.enabled ?? true : null,
      timeout: definition ? definition.timeout ?? AUTOMATION_DEFAULT_TIMEOUT : null,
      overlap: definition ? definition.overlap ?? 'latest' : null,
      next: async () => (await observe())?.next ?? null,
      running: async () => (await observe())?.running ?? null,
      log: input => this.log(owner, input, name),
    };
  }

  async list(owner: AutomationOwner, input: AutomationPageInput = {}): Promise<AutomationPage<AutomationNode>> {
    this.options.signal?.throwIfAborted();
    const entries = Object.entries(owner.declarations ?? {}).filter(([name]) => input.where?.name == null || name === input.where.name)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const selected = page(entries, input);
    return { ...selected, nodes: selected.nodes.map(([name, declaration]) => this.node(owner, name, declaration)) };
  }

  runNode(run: AutomationRunRuntime): AutomationRunNode {
    const { key: _key, definedIn: _definedIn, scope: _scope, projectId, ...fields } = run;
    return {
      ...fields, filePath: join(dirname(run.stdoutLog), 'run.json'),
      action: () => run.scope === 'action' && run.actionId ? this.options.action?.(run.actionId) ?? null : null,
      automation: async () => {
        this.options.signal?.throwIfAborted();
        if (run.scope === 'action') {
          const action = run.actionId && this.options.action?.(run.actionId);
          return action ? this.options.actionAutomation?.(action) ?? null : null;
        }
        const owner = run.scope === 'instance' ? this.options.instanceOwner?.()
          : projectId ? this.options.projectOwner?.(projectId) : null;
        if (!owner?.declarations || !Object.hasOwn(owner.declarations, run.name)) return null;
        this.options.signal?.throwIfAborted();
        return this.node(owner, run.name, owner.declarations[run.name]);
      },
      output: input => {
        this.options.signal?.throwIfAborted();
        if (!this.options.output) throw new GraphQLError('Automation output inspection requires a daemon session.');
        const offset = input.offset ?? 0, limit = input.limit ?? 16384;
        if (!Number.isSafeInteger(offset) || offset < 0) throw new GraphQLError('Automation output offset must be a nonnegative safe integer.');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536) throw new GraphQLError('Automation output limit must be between 1 and 65536 bytes.');
        if (input.stream !== 'stdout' && input.stream !== 'stderr') throw new GraphQLError('Automation output stream must be STDOUT or STDERR.');
        return this.options.output(run.id, input.stream, offset, limit);
      },
    };
  }

  /** History remains within its owner, including removed declarations. */
  async log(owner: AutomationLogOwner = {}, input: AutomationRunPageInput = {}, name?: string): Promise<AutomationPage<AutomationRunNode>> {
    this.options.signal?.throwIfAborted();
    // Validate ranges before obtaining an observation.
    page([], input);
    const snapshot = await this.options.runtime();
    this.options.signal?.throwIfAborted();
    const where = input.where;
    const runs = snapshot.runs.filter(run => inInstance(run, this.root) && inOwner(run, owner) && (name === undefined || run.name === name)
      && (where?.id == null || run.id === where.id) && (where?.name == null || run.name === where.name)
      && (where?.status == null || where.status.includes(run.status)))
      .sort((a, b) => b.started.localeCompare(a.started) || b.id.localeCompare(a.id));
    const selected = page(runs, input);
    return { ...selected, nodes: selected.nodes.map(run => this.runNode(run)) };
  }
}

/** Execution metadata is read independently of Store loading and job scheduling. */
export function executionView(root: string, options: {
  diagnostics: ParseIssue[];
  signal?: AbortSignal;
  catalog?: (refresh: boolean) => Promise<ModelCatalogSnapshot>;
}) {
  return {
    filePath: join(root, '.aside'),
    cwd: () => {
      options.signal?.throwIfAborted();
      try { return readExecutionContext(root).cwd; }
      catch (error) {
        options.diagnostics.push({ severity: 'error', code: 'execution_config', file: join(root, '.aside'),
          message: error instanceof Error ? error.message : String(error) });
        return null;
      }
    },
    models: async ({ refresh }: { refresh?: boolean | null } = {}) => {
      options.signal?.throwIfAborted();
      const snapshot = options.catalog ? await options.catalog(refresh ?? false)
        : await catalogFor(root, { refresh: refresh ?? false, signal: options.signal });
      options.signal?.throwIfAborted();
      options.diagnostics.push(...snapshot.diagnostics.map(message => ({ severity: 'warning' as const,
        code: 'model_discovery', file: join(root, '.aside'), message })));
      return snapshot.models;
    },
  };
}

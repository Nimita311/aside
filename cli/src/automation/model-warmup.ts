import { isBuiltinModelName, validateDefinition } from '../core/automation.js';
import { catalogFor, readExecutionContext, type CatalogOptions, type ModelCatalogSnapshot } from './models.js';
import type { AutomationSource } from './scheduler.js';

export interface ModelWarmupWarning { root: string; key: string; definedIn: string; message: string }
type Lookup = (root: string, options: CatalogOptions) => Promise<ModelCatalogSnapshot>;

// Resolve vendor metadata at ingestion, independently of scheduled deadlines.
// The catalog caches unchanged context, including failed discovery attempts.
export class AutomationModelWarmup {
  private controller = new AbortController();
  private generations = new Map<string, number>();
  private messages = new Map<string, ModelWarmupWarning[]>();
  private pending = new Set<Promise<void>>();
  private sequence = 0;
  constructor(private changed: () => void = () => {}, private lookup: Lookup = catalogFor) {}
  warnings(): ModelWarmupWarning[] { return [...this.messages.values()].flat(); }
  replace(sources: AutomationSource[]): void {
    if (this.controller.signal.aborted) return;
    const roots = new Map<string, Array<AutomationSource & { selection: string }>>();
    for (const source of sources) {
      if (source.blocked) continue;
      try {
        const definition = validateDefinition(source.declaration);
        if (definition.enabled === false || 'script' in definition.run) continue;
        const list = roots.get(source.root) ?? [];
        list.push({ ...source, selection: definition.run.model }); roots.set(source.root, list);
      } catch { /* Invalid declarations already have scheduler diagnostics. */ }
    }
    for (const root of this.generations.keys()) if (!roots.has(root)) {
      this.generations.delete(root); this.messages.delete(root);
    }
    for (const [root, jobs] of roots) {
      const generation = ++this.sequence;
      this.generations.set(root, generation);
      const warnings: ModelWarmupWarning[] = [];
      const warn = (job: AutomationSource, message: string) => warnings.push({ root, key: job.key, definedIn: job.definedIn, message });
      const dependencies: Array<{ job: AutomationSource & { selection: string }; builtin: string }> = [];
      try {
        const { config } = readExecutionContext(root);
        for (const job of jobs) {
          const named = config.models && Object.hasOwn(config.models, job.selection) ? config.models[job.selection] : undefined;
          if (named && 'command' in named) continue;
          const builtin = named?.model ?? job.selection;
          if (isBuiltinModelName(builtin)) dependencies.push({ job, builtin });
          else warn(job, `Model ${JSON.stringify(job.selection)} is not defined in this instance's .aside`);
        }
      } catch (error) { for (const job of jobs) warn(job, (error as Error).message); }
      this.messages.set(root, warnings);
      if (!dependencies.length) continue;
      const work = this.lookup(root, { signal: this.controller.signal }).then(snapshot => {
        if (this.controller.signal.aborted || this.generations.get(root) !== generation) return;
        for (const { job, builtin } of dependencies) {
          const option = snapshot.models.find(model => model.builtin && model.name === builtin);
          if (!option) {
            const engine = builtin.startsWith('CODEX_') ? 'codex' : 'claude';
            const reason = snapshot.diagnostics.filter(message => message.startsWith(engine + ':')).join('; ');
            warn(job, `Model ${JSON.stringify(job.selection)} is unavailable${reason ? ': ' + reason : ' from the installed runtime'}; saved executions keep their selected identity`);
          } else if (option.availability === 'UNKNOWN') warn(job, `Model ${JSON.stringify(job.selection)} availability is unknown${option.reason ? ': ' + option.reason : ''}`);
        }
        for (const diagnostic of snapshot.diagnostics.filter(message => message.includes('persist'))) {
          for (const { job } of dependencies) warn(job, diagnostic);
        }
        this.messages.set(root, warnings); this.changed();
      }).catch(error => {
        if (this.controller.signal.aborted || this.generations.get(root) !== generation) return;
        for (const { job } of dependencies) warn(job, (error as Error).message);
        this.messages.set(root, warnings); this.changed();
      });
      this.pending.add(work);
      void work.finally(() => this.pending.delete(work));
    }
    this.changed();
  }
  async close(): Promise<void> {
    this.controller.abort(); this.generations.clear(); this.messages.clear();
    await Promise.allSettled([...this.pending]);
  }
}

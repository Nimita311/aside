import { assertDelegation } from '../core/delegation.js';
import { parseArtifactHandle } from '../core/artifact-reference.js';
import { AUTOMATION_DEFAULT_TIMEOUT } from '../core/system-config.js';
import { delegationKey } from '../automation/delegation.js';
import { scheduleInstant } from '../core/scheduling.js';
import type { Action, ParseIssue } from '../core/types.js';
import type { AutomationView, AutomationNode, AutomationRunPageInput } from './automations.js';
import type { AutomationRunRuntime, AutomationRuntimeSnapshot } from './automation-runtime.js';

export class DelegationView {
  constructor(private root: string, private options: {
    diagnostics: ParseIssue[];
    runtime: () => Promise<AutomationRuntimeSnapshot>;
    artifact: (id: string) => unknown;
    automations: AutomationView;
    signal?: AbortSignal;
  }) {}
  node(id: string, action: Action, file?: string): AutomationNode | null {
    if (action.frontMatter.delegation === undefined) return null;
    let definition;
    try {definition = assertDelegation(action.frontMatter.delegation);}
    catch (error) {this.options.diagnostics.push({severity: 'error', code: 'invalid_delegation', file, field: 'delegation', message: (error as Error).message}); return null;}
    const key = delegationKey(this.root, id, action);
    const matches = (run: AutomationRunRuntime) => run.scope === 'action' && (run.key === key || action.frontMatter.recurrence !== undefined && run.templateId === id);
    return {name: 'delegation', schedule: null, enabled: !action.frontMatter.resolution, overlap: 'skip', run: {...definition.run, prompt: () => {
      this.options.signal?.throwIfAborted();
      const ref = parseArtifactHandle(definition.run.prompt)!;
      const artifact = this.options.artifact(ref.id);
      if (!artifact) this.options.diagnostics.push({severity: 'error', code: 'delegation_prompt', file, field: 'delegation.run.prompt', message: `Prompt artifact ${ref.id} is missing.`});
      return artifact ?? null;
    }}, timeout: definition.timeout ?? AUTOMATION_DEFAULT_TIMEOUT,
    next: async () => {
      const snapshot = await this.options.runtime();
      if (!snapshot.available || action.frontMatter.resolution) return null;
      const job = snapshot.jobs.find(job => job.key === key);
      if (job) return job.next ?? null;
      const occurrence = action.frontMatter.occurrence;
      const template = occurrence && snapshot.jobs.find(job => job.key === JSON.stringify([this.root, `#action/${occurrence.template}`, 'delegation']));
      return template?.next && Date.parse(template.next) === scheduleInstant(action.frontMatter.scheduled!, action.frontMatter.timezone) ? template.next : null;
    }, running: async () => {
      const snapshot = await this.options.runtime();
      return snapshot.available ? snapshot.jobs.some(job => job.key === key && job.running) || snapshot.runs.some(run => matches(run) && run.status === 'running') : null;
    }, log: (input: AutomationRunPageInput) => this.log(id, action, input)};
  }
  log(id: string, action: Action, input: AutomationRunPageInput = {}) {
    return this.options.automations.log({actionKey: delegationKey(this.root, id, action),
      ...(action.frontMatter.recurrence !== undefined ? {templateId: id} : {})}, input);
  }
}

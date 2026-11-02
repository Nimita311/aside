import type { StoreView as Store } from '../../cli/src/core/data-snapshot';
import type { EntityRef } from '../lib/types';
import type { AvailableInstance } from './backend';

export type EmptyFlowKind = 'instance' | 'filter' | 'timeline';

export function emptyFlowKind(store: Store, filter: EntityRef | null, historySettled: boolean, hasEntries: boolean): EmptyFlowKind | null {
  if (!store.isInitialized() || !store.getInstance() || !historySettled || hasEntries || store.getDiagnostics().length) return null;
  if (filter) return 'filter';
  return store.isVerifiedEmpty() ? 'instance' : 'timeline';
}

export function starterPrompt(instance: AvailableInstance): string {
  return `I am viewing the Aside instance ${JSON.stringify(instance.name || instance.id)} (id: ${JSON.stringify(instance.id)}) at ${JSON.stringify(instance.path)}. Use Aside's select_instance tool with path ${JSON.stringify(instance.path)} to explicitly select this destination in our agent session; the browser selection is independent. Then help me capture a note, organize a project, or plan an action. Ask what I want to work on before saving a record.`;
}

export function renderEmptyFlow(kind: EmptyFlowKind, instance: AvailableInstance, options: {
  clearFilter(): void;
  hasNotes: boolean;
  copy?: (text: string) => Promise<void>;
}): HTMLElement {
  const host = document.createElement('section');
  host.className = 'flow-empty'; host.dataset.emptyKind = kind;
  host.dataset.instanceId = instance.id;
  const title = document.createElement('h2');
  title.textContent = kind === 'instance' ? 'The stage is yours.' : kind === 'filter' ? 'No entries match this filter.' : options.hasNotes ? 'No entries to display.' : 'No notes yet.';
  host.append(title);
  if (kind === 'filter') {
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'btn'; clear.textContent = 'Clear filter';
    clear.addEventListener('click', options.clearFilter); host.append(clear); return host;
  }
  if (kind !== 'instance') return host;
  const finePrint = document.createElement('p'); finePrint.className = 'empty-fine-print';
  finePrint.textContent = 'Ask your agent to capture a note, organize a project, or plan an action. Your records will appear here.';
  const identity = document.createElement('p'); identity.className = 'empty-instance';
  identity.textContent = `${instance.name || instance.id} · ${instance.id}`;
  const path = document.createElement('code'); path.textContent = instance.path; identity.append(document.createElement('br'), path);
  const actions = document.createElement('div'); actions.className = 'empty-actions';
  const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'btn'; copy.textContent = 'Copy a starter prompt';
  const status = document.createElement('p'); status.className = 'empty-copy-status'; status.setAttribute('role', 'status');
  const manual = document.createElement('textarea'); manual.className = 'empty-prompt'; manual.readOnly = true; manual.hidden = true;
  manual.setAttribute('aria-label', 'Starter prompt to copy'); manual.value = starterPrompt(instance);
  copy.addEventListener('click', async () => {
    copy.disabled = true;
    try {
      await (options.copy ?? (text => navigator.clipboard.writeText(text)))(manual.value);
      status.textContent = 'Starter prompt copied.'; manual.hidden = true;
    } catch {
      status.textContent = 'Copy this prompt and paste it into your agent conversation.';
      manual.hidden = false; manual.focus(); manual.select();
    } finally { copy.disabled = false; }
  });
  const guide = document.createElement('details'); guide.className = 'empty-guide';
  const summary = document.createElement('summary'); summary.className = 'btn'; summary.textContent = 'Getting started';
  const steps = document.createElement('ol');
  for (const text of [
    'Open your agent with Aside configured. Paste the starter prompt so it selects this instance explicitly.',
    'Tell your agent what to capture, organize, or plan. It saves your records; this browser is for reading them.',
    'Read your notes in the timeline. Follow project and action links, search your records, or use the date readout to jump through history.',
  ]) { const step = document.createElement('li'); step.textContent = text; steps.append(step); }
  guide.append(summary, steps); actions.append(copy, guide);
  host.append(finePrint, identity, actions, status, manual); return host;
}

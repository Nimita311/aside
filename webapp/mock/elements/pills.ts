import {
  applyRefStatus, renderActionSummary, renderAssetDetail, renderEntry, renderFactsLine,
  renderInstanceSummary, renderProjectSummary, type RenderOptions,
} from '../../src/render';
import { actionMarks, projectMarks } from '../../src/instance';
import type { Action, Project } from '../../lib/types';

const PROJECT = '2026-10-12-aurora', ACTION = '2026-10-12-review', ENTRY = '2026-10-18T09:30';
const CREATED = '2026-10-12T09:00', NOW = '2026-10-18T10:00';
const noop = () => {};
const names: Record<string, string> = {
  [PROJECT]: 'Aurora launch', [ACTION]: 'Launch review', [ENTRY]: 'Review note',
  '2026-10-12-design': 'Design', '2026-10-12-research': 'Research',
  '2026-10-12-contrast': 'Contrast audit', '2026-10-12-copy': 'Write launch copy',
};
const options = (patch: Partial<RenderOptions> = {}): RenderOptions => ({
  now: NOW, nowDate: new Date(NOW), timeFormat: '24h', dateFormat: 'iso',
  expandProjects: false, expandActions: false, activeFilter: null,
  resolveName: (_type, id) => names[id] ?? 'Launch review', resolveArtifactName: () => 'Launch brief',
  refMarks: () => [], routeHref: () => '#pills', artifactHref: () => '#pills',
  onTagClick: noop, onAssetClick: noop, onEntryTimeClick: noop, onArtifactClick: noop, onDateClick: noop,
  ...patch,
});
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function take(root: HTMLElement, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`The production renderer did not create ${selector}.`);
  return element;
}
function entry(content: string, opts = options(), projects: string[] = [], actions: string[] = []): HTMLElement {
  return renderEntry({ meta: { created: ENTRY, projects, actions }, content, weekFile: '2026-10-12' }, opts, node('div'));
}
function compact(type: 'project' | 'action' | 'entry', opts = options(), id = type === 'project' ? PROJECT : type === 'action' ? ACTION : ENTRY): HTMLElement {
  if (type === 'entry') {
    return take(renderAssetDetail('assets/brief.txt', { kind: 'text', text: '' }, opts, [{ id, description: 'Review note' }]), '.tag-entry');
  }
  return take(entry('', opts, type === 'project' ? [id] : [], type === 'action' ? [id] : []), `.tag-${type}`);
}
function inline(handle: string, selector: string, opts = options()): HTMLElement {
  const context = node('span', 'rendered-content');
  context.append(take(entry(handle, opts), selector));
  return context;
}
function group(root: HTMLElement, title: string, flow = false): HTMLElement {
  root.append(node('h3', 'element-subheading', title));
  const samples = node('div', `element-specimen-group${flow ? ' element-specimen-group--flow' : ''}`);
  samples.setAttribute('role', 'group'); samples.setAttribute('aria-label', title);
  root.append(samples); return samples;
}
function row(parent: HTMLElement, label: string, id: string, ...examples: HTMLElement[]): void {
  const sample = node('div', 'element-specimen-row'); sample.dataset.specimen = id;
  const hiddenLabel = parent.classList.contains('element-specimen-group--flow');
  sample.append(node('span', `element-specimen-label${hiddenLabel ? ' element-sr-only' : ''}`, label));
  const specimens = node('div', 'element-specimens'); specimens.append(...examples);
  sample.append(specimens); parent.append(sample);
}
function actionPills(frontMatter: Action['frontMatter'], projected = false): HTMLElement {
  return take(renderActionSummary({ frontMatter, body: '' }, undefined, options(), {
    projects: [], assets: [], stats: { entries: 0 }, projected,
  }, noop), '.status-pills');
}
function projectPills(frontMatter: Project['frontMatter']): HTMLElement {
  return take(renderProjectSummary({ frontMatter, body: '' }, undefined, options(), {
    actions: { scheduled: [], backlog: [] }, related: [], assets: [], stats: { entries: 0 },
  }, noop), '.status-pills');
}

/** Dev-only specimens composed from the app's public rendering surfaces. */
export function renderPills(): HTMLElement {
  const root = node('div', 'element-pill-specimens');
  const identities = group(root, 'References');
  for (const type of ['project', 'action', 'entry'] as const) {
    const id = type === 'project' ? PROJECT : type === 'action' ? ACTION : ENTRY;
    const active = options({ activeFilter: { type, id } });
    const hovered = compact(type); hovered.classList.add('is-cohovered');
    row(identities, type[0].toUpperCase() + type.slice(1), `reference-${type}`,
      compact(type), inline(`#${type}/${id}`, `.inline-tag-${type}`), compact(type, active), hovered);
  }
  row(identities, 'Artifact', 'reference-artifact', inline('#artifact/2026-10-12-brief', '.artifact-link'),
    inline('[Brief](#artifact/2026-10-12-brief)', '.artifact-link'));
  const instance = renderInstanceSummary({ id: 'studio', name: 'Studio' }, options(), {
    projects: [], actions: { scheduled: [], backlog: [] }, assets: [], stats: { entries: 0 },
  }, noop);
  row(identities, 'Instance', 'reference-instance', take(instance, '.entity-title'));
  row(identities, 'Date', 'reference-date', inline('#date/2026-10-19', '.inline-tag-date'),
    inline('#date/2026-10-19T14:00', '.inline-tag-date'));

  const lifecycle = group(root, 'Lifecycle', true);
  for (const ended of [false, true]) {
    const fm = { name: 'Aurora launch', created: CREATED, ...(ended ? { ended: '2026-10-16T17:00' } : {}) };
    const chip = compact('project', options({ resolveName: () => ended ? 'Ended project' : 'Open project' }));
    applyRefStatus(chip, 'project', PROJECT, options({ refMarks: () => projectMarks(fm) }));
    row(lifecycle, `Project · ${ended ? 'Ended' : 'Open'}`, `project-${ended ? 'ended' : 'open'}`, chip, projectPills(fm));
  }
  const cases: [string, string, Partial<Action['frontMatter']>][] = [
    ['Scheduled', 'scheduled', { scheduled: '2026-10-19T14:00', calendar: 'Studio' }],
    ['Backlog', 'backlog', {}],
    ['Slipped', 'slipped', { scheduled: '2026-10-16T14:00', calendar: 'Studio' }],
    ['Due', 'due', { scheduled: '2026-10-19T14:00', calendar: 'Studio', deadline: '2026-10-20' }],
    ['Overdue', 'overdue', { scheduled: '2026-10-19T14:00', calendar: 'Studio', deadline: '2026-10-17' }],
    ['Done', 'done', { resolution: 'done', scheduled: '2026-10-16T14:00' }],
    ['Cancelled', 'cancelled', { resolution: 'cancelled' }],
    ['Due + backlog', 'due-backlog', { deadline: '2026-10-20' }],
    ['Overdue + backlog', 'overdue-backlog', { deadline: '2026-10-17' }],
    ['Due + slipped', 'due-slipped', { deadline: '2026-10-20', scheduled: '2026-10-16T14:00' }],
    ['Overdue + slipped', 'overdue-slipped', { deadline: '2026-10-17', scheduled: '2026-10-16T14:00' }],
  ];
  for (const [label, id, fields] of cases) {
    const fm = { name: 'Launch review', created: CREATED, ...fields };
    const chip = compact('action', options({ resolveName: () => label }));
    applyRefStatus(chip, 'action', ACTION, options({ refMarks: () => actionMarks(fm, new Date(NOW)) }));
    row(lifecycle, `Action · ${label}`, `action-${id}`, chip, actionPills(fm));
  }

  const extras = group(root, 'Groups and exceptions', true);
  const projects = [PROJECT, '2026-10-12-design', '2026-10-12-research'];
  const actions = [ACTION, '2026-10-12-contrast', '2026-10-12-copy'];
  for (const type of ['project', 'action'] as const) {
    const ids = type === 'project' ? projects : actions;
    const opts = options({ activeFilter: { type, id: ids[1] } });
    const make = (expand: boolean) => take(entry('', { ...opts, expandProjects: expand, expandActions: expand },
      type === 'project' ? ids : [], type === 'action' ? ids : []), '.tag-group');
    row(extras, type === 'project' ? 'Projects' : 'Actions', `overflow-${type}`, make(false), make(true));
  }

  const base = { name: 'Launch review', created: CREATED };
  row(extras, 'Recurrence template', 'recurrence-template', compact('action', options({ resolveName: () => 'Template' })), actionPills({ ...base,
    recurrence: [{ dtstart: '2026-10-19T09:00', rrule: 'FREQ=DAILY' }],
  }));
  row(extras, 'Projected occurrence', 'recurrence-projected', compact('action', options({ resolveName: () => 'Occurrence' }), '~2026-10-12-review@2026-10-19T16%3A00%3A00Z'),
    actionPills({ ...base, scheduled: '2026-10-19T09:00', calendar: 'Studio' }, true));
  row(extras, 'Scheduled without a calendar', 'calendar-exception', compact('action', options({ resolveName: () => 'No calendar' })), actionPills({ ...base, scheduled: '2026-10-19T14:00' }));

  row(extras, 'Counts', 'facts-counts', renderFactsLine({ projects: { open: 2, total: 3 }, actions: { open: 4, total: 7 }, entries: 12 }, '2026-10-17T14:00', options()));
  row(extras, 'Zero counts', 'facts-zero', renderFactsLine({ projects: { open: 0, total: 0 }, actions: { open: 0, total: 0 }, entries: 0 }, undefined, options()));
  return root;
}

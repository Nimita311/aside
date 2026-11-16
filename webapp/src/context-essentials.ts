import { bindDisplay, setDisplayText } from './display';
import { ago, type RefStatus, type SummaryPill } from './instance';
import { entityIcon, formatScheduledStamp, markClasses, pillHoverTitle, type RenderOptions } from './render';
import { ICON_SIZE, actionIconState, iconMarkup, projectIconState, refIconState, setEntityIcon, setReferenceIcon } from './entity-icons';

export type EssentialsKind = 'instance' | 'project' | 'action' | 'entry' | 'artifact' | 'attachment' | 'file' | 'date' | 'date-range';
export interface EssentialsCounts {
  entries?: number;
  projects?: { open?: number; total: number };
  actions?: { open?: number; total: number };
  artifacts?: number;
  attachments?: number;
}
export interface ContextEssentials {
  kind: EssentialsKind;
  name: string | ((opts: RenderOptions) => string);
  description?: string;
  path?: string;
  counts?: EssentialsCounts;
  updated?: string;
  status?: (opts: RenderOptions) => SummaryPill[];
  marks?: (opts: RenderOptions) => RefStatus[];
  // The identity icon's state where the kind alone doesn't settle it: the
  // page an artifact, attachment or file opens as, the calendar page a date
  // or a range shows as.
  icon?: string;
}

const labels: Record<EssentialsKind, string> = {
  instance: 'Instance', project: 'Project', action: 'Action', entry: 'Entry', artifact: 'Artifact',
  attachment: 'Attachment', file: 'File', date: 'Date', 'date-range': 'Date range',
};
type CountKind = keyof EssentialsCounts;
// Counts express authored relationships or clear containment. References do
// not imply ownership: artifacts count attachments, not inferred projects or
// backlinks; files and attachments have no census of their own.
const allowedCounts: Record<EssentialsKind, CountKind[]> = {
  instance: ['entries', 'projects', 'actions', 'artifacts'],
  project: ['entries', 'projects', 'actions'], action: ['entries', 'projects'],
  entry: ['projects', 'actions'], artifact: ['attachments'], attachment: [], file: [],
  date: ['entries'], 'date-range': ['entries'],
};
// Each count's unit: its icon, and its noun when there is exactly one.
const countUnit = {
  entries: 'entry', projects: 'project', actions: 'action', artifacts: 'artifact', attachments: 'attachment',
} as const;
// The no-calendar exception: an anomaly rather than a lifecycle state, so
// the one tile glyph outside the entity icons.
const EXCEPTION_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18M8 2v4m8-4v4M3 10h7m4 0h7M3 7V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11M3 11v9a2 2 0 0 0 2 2h14"/></svg>';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(markup: string, className = ''): HTMLElement {
  const node = element('span', className);
  node.setAttribute('aria-hidden', 'true');
  node.innerHTML = markup; // Static renderer icons only, never authored text.
  return node;
}

// The identity's type icon: the open instance's notebook half open, a page
// keyed by what it opens, a calendar page keyed by the date's value. A
// project's, action's or entry's state follows its marks below.
function identityIcon(data: ContextEssentials): string {
  switch (data.kind) {
    case 'date': case 'date-range': return iconMarkup('date', data.icon ?? (data.kind === 'date' ? 'day' : 'range'), ICON_SIZE.identity);
    case 'instance': return entityIcon('instance', 'active', ICON_SIZE.identity);
    case 'artifact': return entityIcon('artifact', data.icon, ICON_SIZE.identity);
    case 'attachment': case 'file': return entityIcon('asset', data.icon, ICON_SIZE.identity);
    default: return entityIcon(data.kind, undefined, ICON_SIZE.identity);
  }
}

function identityMarks(identity: HTMLElement, kind: EssentialsKind, marks: RefStatus[]): void {
  const wanted = markClasses(marks);
  for (const name of Array.from(identity.classList)) if (name.startsWith('tag-status-') && !wanted.includes(name)) identity.classList.remove(name);
  identity.classList.add(...wanted);
  // The icon carries the lifecycle, morphing in place when the marks change.
  const glyph = identity.querySelector<HTMLElement>(':scope > .context-identity-icon');
  if (glyph && (kind === 'project' || kind === 'action' || kind === 'entry')) setReferenceIcon(glyph, kind, refIconState(kind, marks), ICON_SIZE.identity);
}

function renderCounts(data: ContextEssentials, opts: RenderOptions): HTMLElement | undefined {
  const row = element('div', 'summary-facts context-essentials-counts');
  row.setAttribute('aria-label', 'Entity counts and latest activity');
  for (const kind of allowedCounts[data.kind]) {
    const count = data.counts?.[kind];
    if (count === undefined) continue; // A known zero is still worth showing.
    const text = typeof count === 'number' ? String(count) : count.open === undefined ? String(count.total) : `${count.open}/${count.total}`;
    const total = typeof count === 'number' ? count : count.total;
    const name = total === 1 ? countUnit[kind] : kind;
    const label = typeof count !== 'number' && count.open !== undefined ? `${count.open} of ${count.total} ${name} open` : `${total} ${name}`;
    const pair = element('span', 'summary-stat');
    pair.dataset.countKind = kind;
    pair.title = label;
    pair.setAttribute('aria-label', label);
    const markup = kind === 'attachments' ? entityIcon('asset', 'file', ICON_SIZE.stat) : entityIcon(countUnit[kind], undefined, ICON_SIZE.stat);
    pair.append(icon(markup, `stat-icon icon-${countUnit[kind]}`), element('span', 'stat-count', text));
    row.append(pair);
  }
  if (data.updated) {
    row.append(bindDisplay(element('span', 'facts-updated'), opts, (node, current) => setDisplayText(node, `updated ${ago(data.updated!, current.nowDate)}`)));
  }
  return row.childElementCount ? row : undefined;
}

function factLabel(state: SummaryPill): 'Scheduled' | 'Deadline' | undefined {
  // A resolved status may retain a scheduled hover; it still reads simply
  // Done/Cancelled, without forcing a redundant label above the status.
  if (state.hover?.prefix === 'Scheduled') return 'Scheduled';
  if (state.hover?.prefix === 'Deadline') return 'Deadline';
  return undefined;
}

// A tile's glyph is its entity's icon in the tile's state: an action's ring
// plain, dashed, with clock hands, ticked, slashed or looping; a project's
// ribbon hollow or ticked. A deadline fact uses the plain action ring.
// As the state changes the glyph morphs in place.
function factGlyph(glyph: HTMLElement, kind: EssentialsKind, state: SummaryPill): void {
  // Compare by a flag, not by markup: the parsed SVG never serializes back
  // to the source string, so a markup check would rewrite it every repaint.
  if (state.exception) {
    if (glyph.dataset.exception === undefined) { glyph.innerHTML = EXCEPTION_ICON; glyph.dataset.exception = ''; }
    return;
  }
  if (glyph.dataset.exception !== undefined) { glyph.replaceChildren(); delete glyph.dataset.exception; }
  if (kind === 'project') setEntityIcon(glyph, 'project', projectIconState(state.marks), ICON_SIZE.tile);
  else setEntityIcon(glyph, 'action', actionIconState(state.marks), ICON_SIZE.tile);
}

function renderStatus(kind: EssentialsKind, read: NonNullable<ContextEssentials['status']>, opts: RenderOptions): HTMLElement {
  const group = element('div', 'context-essentials-facts');
  group.setAttribute('aria-label', 'Key information');
  group.dataset.liveContainer = '';
  const slots: { root: HTMLElement; label: HTMLElement; value: HTMLElement; glyph: HTMLElement; annotation: HTMLElement }[] = [];
  return bindDisplay(group, opts, (node, current) => {
    const states = read(current);
    node.hidden = !states.length;
    for (let index = 0; index < Math.max(states.length, slots.length); index++) {
      let slot = slots[index];
      if (!slot) {
        const root = element('div', 'context-essential-fact');
        const label = element('div', 'context-essential-label');
        const value = element('div', 'context-essential-value');
        const glyph = icon('', 'context-essential-icon');
        const annotation = element('div', 'context-essential-annotation');
        root.append(label, value, annotation); node.append(root);
        slots.push(slot = { root, label, value, glyph, annotation });
      }
      const state = states[index];
      slot.root.hidden = !state;
      if (!state) continue;
      const label = factLabel(state);
      slot.root.title = pillHoverTitle(state, current);
      slot.root.classList.toggle('is-overdue', state.marks.includes('overdue'));
      slot.root.classList.toggle('is-due', state.marks.includes('due'));
      slot.root.classList.toggle('is-standalone', !label);
      slot.label.hidden = !label;
      if (label) {
        setDisplayText(slot.label, label);
        if (slot.label.firstElementChild !== slot.glyph) slot.label.prepend(slot.glyph);
      } else if (slot.value.firstElementChild !== slot.glyph) slot.value.prepend(slot.glyph);
      factGlyph(slot.glyph, kind, state);
      const raw = label ? state.label.replace(label === 'Scheduled' ? /^Scheduled\s+/ : /^(?:Due|Deadline)\s+/, '') : state.label;
      const text = raw.charAt(0).toUpperCase() + raw.slice(1);
      let valueText = slot.value.querySelector<HTMLElement>('.context-essential-text');
      if (!valueText) { valueText = element('span', 'context-essential-text'); slot.value.append(valueText); }
      setDisplayText(valueText, text);
      slot.root.setAttribute('aria-label', label ? `${label}: ${text}` : text);
      slot.annotation.hidden = !state.hover?.timezone;
      if (state.hover?.timezone) setDisplayText(slot.annotation, formatScheduledStamp(state.hover.stamp, state.hover.timezone, current));
    }
  });
}

// One header serves both panel configurations. The same bound nodes repaint
// clock-sensitive labels without remounting the body or changing its layout.
export function renderContextEssentials(data: ContextEssentials, opts: RenderOptions): HTMLElement {
  const header = element('header', 'context-essentials');
  header.dataset.kind = data.kind;
  const row = element('div', 'context-essentials-row');
  const heading = element('h2', 'entity-title');
  const type = data.kind === 'file' || data.kind === 'attachment' ? 'asset' : data.kind === 'date-range' ? 'date' : data.kind;
  const identity = element('span', `context-identity ref-identity icon-${type}`);
  const label = element('span', 'entity-title-label tag-text');
  identity.append(icon(identityIcon(data), 'context-identity-icon'), label);
  heading.append(identity);
  row.append(heading, element('span', 'context-essentials-type', labels[data.kind]));
  header.append(row);
  bindDisplay(identity, opts, (node, current) => {
    const name = typeof data.name === 'string' ? data.name : data.name(current);
    setDisplayText(label, name);
    node.title = name;
    identityMarks(node, data.kind, data.marks?.(current) ?? data.status?.(current).flatMap(state => state.marks) ?? []);
  });
  if (data.description) header.append(element('p', 'summary-description', data.description));
  if (data.path) header.append(element('p', 'asset-path context-essentials-path', data.path));
  const counts = renderCounts(data, opts);
  if (counts) header.append(counts);
  if (data.status) header.append(renderStatus(data.kind, data.status, opts));
  return header;
}

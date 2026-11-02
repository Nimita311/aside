import { Marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';
import { prepareDiagrams } from './diagrams';
import { webpageFrame } from './webpage';
import type { Artifact } from '../../cli/src/core/types';
import { splitFrontMatter } from '../../cli/src/core/markdown';
import {
  artifactHandle, artifactRecordPath, artifactAttachmentRelativePath, artifactContentFilename,
  assertArtifactId, assertAttachmentFilename, parseArtifactHandle,
  type ArtifactReference,
} from '../../cli/src/core/artifact-reference';
import type {
  Entry,
  Project,
  Action,
  Manifest,
  EntityRef,
  AssetLink,
} from '../lib/types';
import { resolveRelativePath, weekFilePath, entityFilePath, assetDisplayName } from '../lib/types';
import { buildRoute } from './route';
import { bindDisplay, setDisplayText, moveDisplayNode, refreshRevealed } from './display';
import { entityMentions, parseEntityHandle } from './entity-reference';
import { dateHandle, dateMentions, dateTimeAttribute, localDateStamp, type DateReference } from './date-reference';
import type { HierarchyNode } from './hierarchy';
import { scheduleInstant, wallTimeAt } from '../../cli/src/core/scheduling';
import { relativeDate, timelineWindow, stampInstant, clockInstant, actionPills, projectPills, ago, type OpenActionGroups, type RefStatus, type SummaryPill } from './instance';

import { formatStamp, formatTime, formatDate, formatClock, dateColumns, calendarLabel, type DateTimeFormat } from './date-display';
import type { DateTimePreferences } from './preferences';
export { formatStamp, formatTime } from './date-display';
export type { TimeFormat } from './preferences';
// `source` is the clicked tag element — navigation uses it to anchor the
// enclosing entry card in the viewport across the re-render.
type OnTagClick = (ref: EntityRef, source?: HTMLElement) => void;
type OnAssetClick = (path: string) => void;
type ResolveName = (type: EntityRef['type'], id: string) => string;

// Reserve complete date candidates before Markdown can interpret a zone's
// brackets as a reference link. Validate and linkify their resulting prose
// after sanitizing, alongside the other handles. Code and links still lex normally.
const markdownParser = new Marked({ extensions: [{
  name: 'dateReference', level: 'inline',
  start: source => source.indexOf('#date/'),
  tokenizer(source) {
    const match = /^#date\/[^\s<>(){}"'`]+/.exec(source);
    if (match) return { type: 'dateReference', raw: match[0] };
  },
  renderer: token => token.raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}] });

export interface RenderOptions extends DateTimePreferences {
  // The rendering moment — the stamp the status pills and updated lines read
  // their relative dates against.
  now: string;
  nowDate: Date;
  liveDurationMs?: number;
  expandProjects: boolean;
  expandActions: boolean;
  // The entity the flow is filtered to — its tags and mentions render bold.
  activeFilter: EntityRef | null;
  resolveName: ResolveName;
  onTagClick: OnTagClick;
  onAssetClick: OnAssetClick;
  onArtifactClick?: (id: string, filename?: string) => void;
  resolveArtifactName?: (id: string) => string;
  artifactHref?: (id: string, filename?: string) => string;
  artifactFileUrl?: (id: string, filename?: string) => string | null;
  assetFileUrl?: (path: string) => string | null;
  onMediaError?: (path: string, error: Error, media: HTMLElement) => void;
  onWebpageReady?: (frame: HTMLIFrameElement) => void;
  // The gutter time was clicked — scroll its entry to the top and deep-link it.
  onEntryTimeClick: (entryId: string) => void;
  onDateClick?: (ref: DateReference) => void;
  // Route -> instance-scoped href, for native deep links.
  routeHref: (route: string) => string;
  // Lifecycle marks lookup for reference chips — empty for entries and for
  // ids not (yet) in the store's caches. An open action can carry two marks
  // (a due/overdue one and a backlog/slipped one); every other ref at most
  // one.
  refMarks: (type: 'project' | 'action' | 'entry', id: string) => RefStatus[];
}

function isActiveRef(opts: RenderOptions, type: string, id: string): boolean {
  return opts.activeFilter !== null && opts.activeFilter.type === type && opts.activeFilter.id === id;
}

// The links shown with an entry's detail — its tagged projects and actions
// and the assets its content links.
export interface EntityRelations {
  projects?: string[];
  actions?: string[];
  assets?: AssetLink[];
}

const ENTITY_ICONS: Record<string, string> = {
  instance: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>',
  entry: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/></svg>',
  project: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/></svg>',
  action: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>',
  asset: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  // The search dropdown's jump-to-date rows — a moment, not an entity.
  date: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
};

export function entityIcon(type: string): string {
  return ENTITY_ICONS[type === 'artifact' ? 'asset' : type] || '';
}

// The waiting mark — one grey glyph, two faces of the calendar slot,
// trailing an action with no time ahead on the calendar: a dashed empty
// circle while a time was never set (backlog — the slot never filled), a
// clock face with hands once a set time lapsed (slipped — a real time that
// ran out). Smaller than the type icon, the pill's second channel.
// The other marks read from the pill itself: a deadline is a ring around it
// (CSS), composing with the slot glyph rather than occupying its place;
// upcoming work and live projects are the clean pill; and closed work (done,
// cancelled, ended) mutes — the CSS greys the field and washes the name
// while the icon keeps the full type color, a cancelled name additionally
// striking through.
const WAITING_CLOCK = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
// Six round dashes on the same circle — legible texture at 9px, not a
// stipple (2π·10 ≈ 62.8 splits into six 4+6.47 periods).
const EMPTY_SLOT = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10" stroke-dasharray="4 6.47"/></svg>';

// The classes a set of marks paints on a chip: one per mark, plus the shared
// closed class — done, cancelled, and ended are one visual family (the
// mute), so the CSS styles the family, not each member.
function markClasses(marks: RefStatus[]): string[] {
  const classes = marks.map((mark) => `tag-status-${mark}`);
  if (marks.some((mark) => mark === 'done' || mark === 'cancelled' || mark === 'ended')) {
    classes.push('tag-status-closed');
  }
  return classes;
}

// Dress an element in its lifecycle marks: the mark classes (driving the due
// ring and the closed mute) plus the calendar-slot glyph where one applies —
// the dashed empty slot for backlog, the clock for slipped.
function applyMarks(host: HTMLElement, marks: RefStatus[], slotVisible = true): void {
  // Rewrite the mark classes only when they change: a repaint carrying the
  // same marks must not invalidate the chip's style every minute.
  const present = Array.from(host.classList).filter((name) => name.startsWith('tag-status-'));
  const wanted = new Set(markClasses(marks));
  if (present.length !== wanted.size || present.some((name) => !wanted.has(name))) {
    host.classList.remove(...present);
    host.classList.add(...wanted);
  }
  const slot = !slotVisible ? null : marks.includes('backlog') ? EMPTY_SLOT : marks.includes('slipped') ? WAITING_CLOCK : null;
  const current = host.querySelector<HTMLElement>(':scope > .ref-status');
  if (current?.innerHTML === slot) return;
  current?.remove();
  if (slot) {
    const glyph = el('span', { className: 'ref-status' });
    glyph.innerHTML = slot; // hardcoded SVG only — never user data
    host.appendChild(glyph);
  }
}

// Fill an element with a type icon. The SVG is a hardcoded constant — never
// user data — so setting innerHTML is safe.
function setIcon(host: HTMLElement, type: string): void {
  host.innerHTML = entityIcon(type);
}

const INLINE_ARTIFACT_RE = /(?<![\p{L}\p{N}_/\\])#artifact\/[^\s<>()[\]{}"'`]+/gu;

function validArtifactReference(handle: string): ArtifactReference | undefined {
  const ref = parseArtifactHandle(handle);
  if (!ref) return undefined;
  try {
    assertArtifactId(ref.id);
    if (ref.filename !== undefined) assertAttachmentFilename(ref.filename);
    return ref;
  } catch {
    return undefined;
  }
}

function artifactLink(id: string, filename: string | undefined, opts: RenderOptions, label?: string): HTMLAnchorElement {
  const handle = artifactHandle(id, filename);
  const anchor = el('a', {
    className: 'artifact-link',
    href: opts.artifactHref?.(id, filename) ?? handle,
    title: handle,
    textContent: label ?? filename ?? opts.resolveArtifactName?.(id) ?? id,
  });
  wireArtifactLink(anchor, id, filename, opts);
  return anchor;
}

function wireArtifactLink(anchor: Element, id: string, filename: string | undefined, opts: RenderOptions): void {
  anchor.classList.add('artifact-link');
  anchor.setAttribute('href', opts.artifactHref?.(id, filename) ?? artifactHandle(id, filename));
  if (!opts.onArtifactClick) return;
  wireNavigationLink(anchor, () => opts.onArtifactClick!(id, filename));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string>,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'className') node.className = v;
      else if (k === 'textContent') node.textContent = v;
      else node.setAttribute(k, v);
    }
  }
  if (children) {
    for (const child of children) {
      node.append(typeof child === 'string' ? document.createTextNode(child) : child);
    }
  }
  return node;
}

// Intercept only an ordinary activation. Modifiers, middle clicks, explicit
// new-window targets, and downloads keep the browser's native link behavior.
function wireNavigationLink(anchor: Element, navigate: () => void): void {
  anchor.addEventListener('click', event => {
    const e = event as MouseEvent;
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (anchor.hasAttribute('download') || (anchor.getAttribute('target') && anchor.getAttribute('target') !== '_self')) return;
    e.preventDefault();
    e.stopPropagation();
    navigate();
  });
}

function referenceHref(type: 'project' | 'action' | 'entry', id: string, opts: RenderOptions): string {
  return opts.routeHref(buildRoute(type === 'entry'
    ? { filter: opts.activeFilter?.type === 'entry' ? null : opts.activeFilter, doc: null, jump: id }
    : { filter: { type, id }, doc: null }));
}

function wireDateLink(anchor: HTMLAnchorElement, ref: DateReference, opts: RenderOptions): void {
  anchor.classList.add('inline-tag', 'inline-tag-date');
  anchor.dataset.dateHandle = dateHandle(ref);
  anchor.insertAdjacentHTML('afterbegin', entityIcon(ref.start.length === 10 ? 'action' : 'date'));
  const label = el('time', { dateTime: dateTimeAttribute(ref.start) });
  anchor.append(label);
  bindDisplay(anchor, opts, (node, current) => {
    const display = (stamp: string) => {
      const datetime = dateTimeAttribute(stamp);
      const instant = /(?:Z|[+-]\d{2}:\d{2})$/.test(datetime) ? Date.parse(datetime) : undefined;
      return formatStamp(localDateStamp(stamp), current, instant === undefined ? undefined : { instant });
    };
    setDisplayText(label, `${display(ref.start)}${ref.end ? ` – ${display(ref.end)}` : ''}`);
    const absolute = (stamp: string) => `${stamp} (${weekdayName(stamp.slice(0, 10))})`;
    node.title = `${absolute(ref.start)}${ref.end ? ` / ${absolute(ref.end)}` : ''} · Jump to ${ref.end ? 'range start' : 'timeline'}`;
    describeReference(node, node.title);
    const filter = current.activeFilter?.type === 'entry' ? null : current.activeFilter;
    node.setAttribute('href', current.routeHref(buildRoute({ filter, doc: null, date: ref })));
  });
  if (opts.onDateClick) wireNavigationLink(anchor, () => opts.onDateClick!(ref));
}

let nextControlId = 1;
function controlId(prefix: string): string { return `${prefix}-${nextControlId++}`; }

const MARK_DESCRIPTIONS: Record<RefStatus, string> = {
  due: 'deadline due', overdue: 'deadline overdue', scheduled: 'scheduled',
  backlog: 'unscheduled', slipped: 'schedule lapsed', done: 'done',
  cancelled: 'cancelled', open: 'open', ended: 'ended',
};
function referenceDescription(type: 'project' | 'action' | 'entry', marks: RefStatus[]): string {
  return [type[0].toUpperCase() + type.slice(1), ...marks.map(mark => MARK_DESCRIPTIONS[mark])].join('; ');
}
// Explicitly referenced hidden text contributes to the description, while
// the authored link text remains its accessible name and visible label.
function describeReference(host: HTMLElement, text: string): void {
  let description = host.querySelector<HTMLElement>(':scope > .ref-description');
  if (!description) {
    description = el('span', { className: 'ref-description', id: controlId('ref-description') });
    description.hidden = true;
    host.appendChild(description);
    const existing = host.getAttribute('aria-describedby');
    host.setAttribute('aria-describedby', [existing, description.id].filter(Boolean).join(' '));
  }
  setDisplayText(description, text);
}

// The shared body of a reference chip — icon, resolved name, status, and the
// ref dataset plus active state that hover-linking and filter-bolding key
// off. Callers pick the class variant and attach the click behavior.
function refChip(
  type: 'project' | 'action' | 'entry',
  id: string,
  opts: RenderOptions,
  className: string,
): HTMLElement {
  const span = el('a', { className, href: referenceHref(type, id, opts) });
  if (isActiveRef(opts, type, id)) span.classList.add('is-active');
  span.dataset.refType = type;
  span.dataset.refId = id;
  span.title = id;
  setIcon(span, type);
  const label = el('span', { className: 'tag-text', textContent: opts.resolveName(type, id) });
  if (type === 'entry') bindDisplay(label, opts, (node, current) => setDisplayText(node, current.resolveName(type, id)));
  span.appendChild(label);
  applyRefStatus(span, type, id, opts);
  return span;
}

// Dress a chip in the marks of the entity it references.
export function applyRefStatus(
  chip: HTMLElement,
  type: 'project' | 'action' | 'entry',
  id: string,
  opts: RenderOptions,
): void {
  bindDisplay(chip, opts, (node, current) => {
    const marks = current.refMarks(type, id);
    applyMarks(node, marks);
    describeReference(node, referenceDescription(type, marks));
  });
}

function renderTag(
  type: 'project' | 'action' | 'entry',
  id: string,
  opts: RenderOptions,
  onClick: (source: HTMLElement) => void,
): HTMLElement {
  const span = refChip(type, id, opts, `tag tag-${type}`);
  wireNavigationLink(span, () => onClick(span));
  return span;
}

// `baseFile` is the root-relative path of the file the markdown came from;
// relative links are resolved against it and opened in-app as assets.
function renderContent(markdown: string, opts: RenderOptions, baseFile?: string): HTMLElement {
  const renderer = new Renderer();
  const renderText = renderer.text.bind(renderer);
  const renderLink = renderer.link.bind(renderer);
  renderer.link = token => {
    const html = renderLink(token);
    return /\]\(\s*<?\\#/.test(token.raw) ? html.replace('href="#', 'href="&#35;') : html;
  };
  renderer.text = (token) => token.type === 'escape' && token.text === '#' ? '&#35;' : renderText(token);
  const rawHtml = markdownParser.parse(markdown, { async: false, renderer });
  // Markdown escapes and HTML entities can display a hash without spelling a
  // reference in the source. Keep those hashes literal through linkification.
  let literalHash = `\uE000aside-literal-${Math.random().toString(36).slice(2)}\uE001`;
  while (rawHtml.includes(literalHash)) literalHash += '\uE002';
  const protectedHtml = rawHtml.replace(/&#(?:0*35(?!\d)|x0*23(?![\da-f]));?|&num;/gi, literalHash);
  const wrapper = el('div', { className: 'rendered-content' });
  // No data-* attributes: content quoting the app's own markup must not
  // inject nodes the flow's [data-entry-id] anchor and jump queries would find.
  const template = document.createElement('template');
  template.innerHTML = DOMPurify.sanitize(protectedHtml, {
    // Authored CSS can inspect private metadata elsewhere in the app DOM and
    // disclose matching values through network requests, without any scripts.
    ALLOW_DATA_ATTR: false, ADD_TAGS: ['iframe'], FORBID_TAGS: ['style'], FORBID_ATTR: ['srcdoc', 'style'],
  });
  // Process in inert template content: no authored iframe is mounted before
  // its URL is resolved and its privileges are replaced by app-owned defaults.
  for (const authored of template.content.querySelectorAll('iframe')) {
    const src = authored.getAttribute('src') ?? '';
    const artifact = validArtifactReference(src);
    const local = baseFile ? resolveRelativePath(baseFile, src) : null;
    let url: string | null = null;
    if (!src.includes(literalHash)) {
      if (artifact) url = opts.artifactFileUrl?.(artifact.id, artifact.filename) ?? null;
      else if (local) url = opts.assetFileUrl?.(local) ?? null;
      else if (/^https?:\/\//i.test(src)) {
        try {
          const parsed = new URL(src);
          if (!parsed.username && !parsed.password) url = parsed.href;
        } catch { /* Invalid destinations never become browsing contexts. */ }
      }
    }
    if (!url) { authored.remove(); continue; }
    const filePath = artifact?.filename ? artifactAttachmentRelativePath(artifact.id, artifact.filename) : local ?? undefined;
    const frame = webpageFrame(authored.getAttribute('title') ?? '', filePath, artifact?.id);
    frame.src = url;
    const height = authored.getAttribute('height') ?? '';
    if (/^\d+$/.test(height)) frame.style.height = `${Math.min(2000, Math.max(100, Number(height)))}px`;
    authored.replaceWith(frame);
    opts.onWebpageReady?.(frame);
  }
  wrapper.appendChild(template.content);

  for (const anchor of Array.from(wrapper.querySelectorAll('a[href]'))) {
    if (anchor.closest('pre, code')) continue;
    const href = anchor.getAttribute('href') ?? '';
    if (href.includes(literalHash)) continue;
    const entity = parseEntityHandle(href);
    if (entity) {
      anchor.classList.add('inline-tag', `inline-tag-${entity.type}`);
      if (isActiveRef(opts, entity.type, entity.id)) anchor.classList.add('is-active');
      const link = anchor as HTMLAnchorElement;
      link.dataset.refType = entity.type;
      link.dataset.refId = entity.id;
      link.title ||= href;
      anchor.insertAdjacentHTML('afterbegin', entityIcon(entity.type));
      anchor.setAttribute('href', referenceHref(entity.type, entity.id, opts));
      applyRefStatus(link, entity.type, entity.id, opts);
      wireNavigationLink(anchor, () => opts.onTagClick(entity, link));
      continue;
    }
    const artifact = validArtifactReference(href);
    if (artifact) {
      wireArtifactLink(anchor, artifact.id, artifact.filename, opts);
      continue;
    }
    const assetPath = baseFile ? resolveRelativePath(baseFile, href) : null;
    if (assetPath) {
      anchor.classList.add('asset-link');
      anchor.insertAdjacentHTML('afterbegin', entityIcon('asset')); // hardcoded SVG only — never user data
      // Real href so copy/middle-click deep-link; in-app handling on plain click.
      anchor.setAttribute('href', opts.routeHref(buildRoute({ filter: opts.activeFilter, doc: { kind: 'asset', path: assetPath } })));
      wireNavigationLink(anchor, () => opts.onAssetClick(assetPath));
    } else if (/^https?:/i.test(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener');
    }
  }

  for (const img of Array.from(wrapper.querySelectorAll('img[src]'))) {
    if (img.closest('pre, code')) continue;
    const src = img.getAttribute('src') ?? '';
    if (src.includes(literalHash)) continue;
    const artifact = validArtifactReference(src);
    if (!artifact) continue;
    (img as HTMLImageElement).dataset.artifactHandle = artifactHandle(artifact.id, artifact.filename);
    const url = opts.artifactFileUrl?.(artifact.id, artifact.filename);
    if (url) img.setAttribute('src', url);
    else img.removeAttribute('src');
  }

  // Local media uses the containing file's instance, independent of the
  // browser view path. External URLs retain their authored destination.
  for (const media of Array.from(wrapper.querySelectorAll('img[src], video[src], audio[src], source[src], track[src], video[poster]'))) {
    if (media.closest('pre, code')) continue;
    for (const attribute of ['src', 'poster']) {
      const authored = media.getAttribute(attribute);
      if (!authored || authored.includes(literalHash) || validArtifactReference(authored)) continue;
      const local = baseFile ? resolveRelativePath(baseFile, authored) : null;
      if (!local) continue;
      const url = opts.assetFileUrl?.(local);
      if (url) media.setAttribute(attribute, url);
      else media.removeAttribute(attribute);
    }
  }

  // Work on text nodes after Markdown parsing, so code and link labels retain
  // their authored content and cannot become nested links.
  const artifactWalker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
  const artifactNodes: Text[] = [];
  let artifactNode: Text | null;
  while ((artifactNode = artifactWalker.nextNode() as Text | null)) {
    if (artifactNode.parentElement?.closest('pre, code, a')) continue;
    INLINE_ARTIFACT_RE.lastIndex = 0;
    if (INLINE_ARTIFACT_RE.test(artifactNode.data)) artifactNodes.push(artifactNode);
  }
  for (const textNode of artifactNodes) {
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    INLINE_ARTIFACT_RE.lastIndex = 0;
    for (const match of textNode.data.matchAll(INLINE_ARTIFACT_RE)) {
      const handle = match[0].replace(/[.,;:!?]+$/g, '');
      if (handle.includes(literalHash)) continue;
      const ref = validArtifactReference(handle);
      if (!ref) continue;
      frag.append(document.createTextNode(textNode.data.slice(lastIndex, match.index)),
        artifactLink(ref.id, ref.filename, opts));
      lastIndex = match.index + handle.length;
    }
    if (lastIndex === 0) continue;
    frag.appendChild(document.createTextNode(textNode.data.slice(lastIndex)));
    textNode.parentNode!.replaceChild(frag, textNode);
  }

  const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.parentElement?.closest('pre, code, a')) continue;
    if (entityMentions(node.data).length) textNodes.push(node);
  }

  for (const textNode of textNodes) {
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    for (const { ref, index, length } of entityMentions(textNode.data)) {
      frag.appendChild(document.createTextNode(textNode.data.slice(lastIndex, index)));
      frag.appendChild(createInlineTagElement(ref.type, ref.id, opts));
      lastIndex = index + length;
    }
    if (lastIndex < textNode.data.length) {
      frag.appendChild(document.createTextNode(textNode.data.slice(lastIndex)));
    }
    textNode.parentNode!.replaceChild(frag, textNode);
  }

  const dateWalker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
  const dateNodes: Text[] = [];
  while ((node = dateWalker.nextNode() as Text | null)) {
    if (!node.parentElement?.closest('pre, code, a') && dateMentions(node.data).length) dateNodes.push(node);
  }
  for (const textNode of dateNodes) {
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    for (const { ref, index, length } of dateMentions(textNode.data)) {
      frag.append(document.createTextNode(textNode.data.slice(lastIndex, index)));
      const anchor = el('a');
      wireDateLink(anchor, ref, opts);
      frag.append(anchor);
      lastIndex = index + length;
    }
    frag.append(document.createTextNode(textNode.data.slice(lastIndex)));
    textNode.parentNode!.replaceChild(frag, textNode);
  }

  if (protectedHtml !== rawHtml) {
    const literals = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);
    while ((node = literals.nextNode() as Text | null)) {
      if (node.data.includes(literalHash)) node.data = node.data.split(literalHash).join('#');
    }
    for (const element of Array.from(wrapper.querySelectorAll('*'))) {
      for (const attr of Array.from(element.attributes)) {
        if (attr.value.includes(literalHash)) element.setAttribute(attr.name, attr.value.split(literalHash).join('#'));
      }
    }
  }
  prepareDiagrams(wrapper);
  return wrapper;
}

function createInlineTagElement(type: 'project' | 'action' | 'entry', id: string, opts: RenderOptions): HTMLElement {
  const span = refChip(type, id, opts, `inline-tag inline-tag-${type}`);
  wireNavigationLink(span, () => opts.onTagClick({ type, id }, span));
  return span;
}

function weekdayName(date: string): string {
  return calendarLabel(date, { weekday: 'short' });
}

// Zoned schedules display in the browser zone and retain the authored clock
// visibly. A crossed day includes both dates; all-day and floating values keep
// their authored form.
export function formatScheduledStamp(stamp: string, timezone: string | undefined, format: DateTimeFormat): string {
  if (!timezone || stamp.length <= 10) return formatStamp(stamp, format);
  const instant = scheduleInstant(stamp, timezone);
  if (instant === undefined) return `${formatStamp(stamp, format)} (${timezone}; invalid schedule)`;
  const local = wallTimeAt(instant);
  const original = local.slice(0, 10) === stamp.slice(0, 10) ? formatClock(stamp, format, undefined, { instant, timeZone: timezone }) : formatStamp(stamp, format, { instant, timeZone: timezone });
  return `${formatStamp(local, format, { instant })} (${original} ${timezone})`;
}

function scheduleAnnotation(stamp: string, timezone: string, opts: RenderOptions): HTMLElement {
  const text = bindDisplay(el('span', { className: 'schedule-time' }), opts, (node, current) => setDisplayText(node, formatScheduledStamp(stamp, timezone, current)));
  text.dataset.scheduled = stamp;
  text.dataset.timezone = timezone;
  return text;
}

// A gutter marker on the first (latest) entry of a day, showing only the
// units that changed since `prev`, the day above it in the flow: the day
// number within a month, month + day at a month boundary, year + month + day
// at a year boundary or at the top of the flow.
export function renderDateMarker(date: string, prev: string | null, prefs: DateTimePreferences = { timeFormat: 'locale' }): HTMLElement {
  const marker = el('div', { className: 'date-marker' });
  marker.dataset.date = date;
  if (!prev) marker.classList.add('is-first');
  const paint = (node: HTMLElement, current: DateTimePreferences) => {
    const columns = dateColumns(date, current);
    const visible = columns.map(part => part.type === 'year' ? !prev || prev.slice(0, 4) !== date.slice(0, 4)
      : part.type === 'month' ? !prev || prev.slice(0, 7) !== date.slice(0, 7) : part.type !== 'literal');
    const keys = new Set(columns.map(part => part.key));
    for (const span of Array.from(node.children) as HTMLElement[]) if (!keys.has(span.dataset.datePart!)) span.remove();
    columns.forEach((part, index) => {
      const show = part.type === 'literal'
        ? (index === 0 || visible[index - 1]) && (index === columns.length - 1 || visible.slice(index + 1).some(Boolean)) : visible[index];
      let span = node.querySelector<HTMLElement>(`[data-date-part="${part.key}"]`);
      if (!span) {
        span = el('span', { className: `dm-${part.type} dm-date-part` });
        span.dataset.datePart = part.key;
      }
      if (node.children[index] !== span) node.insertBefore(span, node.children[index] ?? null);
      setDisplayText(span, show ? part.value : '');
      span.style.width = `${part.width}ch`;
    });
    node.title = formatDate(date, current.dateFormat);
  };
  if ('nowDate' in prefs) bindDisplay(marker, prefs as RenderOptions, paint);
  else paint(marker, prefs);
  return marker;
}

// The separation at which the incoming value contacts the latched one and
// starts pushing it — roughly the glyph height plus a hair of daylight
// (glyphs span ~5..16px of the 20px line box), so the pair reads as one
// connected reel rather than two boxes a full line apart.
const LATCH_CONTACT_PX = 12;

// Render the latched readout with the next day riding in: `from` is the
// latched date, `to` the approaching day, and `ghostY` that day's marker
// distance below the readout row in px (Infinity when out of range). Each
// unit whose value changes carries a second span translated to the marker's
// real position — one visible instance, the chip's copy continuing it
// seamlessly as the marker passes behind the chip's solid backdrop — and on
// contact it pushes the old value up and out, one connected roll. Every
// position is a pure function of the scroll, so reversing rewinds it.
// Unchanged units hold still; a day tick rolls just the day number.
export function scrubLatchDate(chip: HTMLElement, from: string, to: string | null, ghostY: number, prefs: DateTimePreferences = { timeFormat: 'locale' }): void {
  const a = dateColumns(from, prefs);
  const b = to ? dateColumns(to, prefs) : a;
  const y = Math.min(Math.max(ghostY, 0), 100);
  const row = chip.querySelector<HTMLElement>('.latch-date-row');
  if (!row) return;
  const keys = new Set(a.map(part => part.key));
  for (const cell of Array.from(row.children) as HTMLElement[]) if (!keys.has(cell.dataset.datePart!)) cell.remove();
  a.forEach((part, index) => {
    const fromVal = part.value, toVal = b[index]?.value ?? fromVal;
    let cell = row.querySelector<HTMLElement>(`[data-date-part="${part.key}"]`);
    if (!cell) {
      cell = el('div', { className: `latch-unit latch-${part.type}` });
      cell.dataset.datePart = part.key;
    }
    if (row.children[index] !== cell) row.insertBefore(cell, row.children[index] ?? null);
    if (cell.dataset.from !== fromVal || cell.dataset.to !== toVal || cell.dataset.width !== String(part.width)) {
      cell.dataset.from = fromVal; cell.dataset.to = toVal; cell.dataset.width = String(part.width);
      cell.replaceChildren(el('span', { className: `dm-${part.type}`, textContent: fromVal }));
      if (toVal !== fromVal) cell.appendChild(el('span', { className: `dm-${part.type}`, textContent: toVal }));
      for (const span of Array.from(cell.children) as HTMLElement[]) span.style.width = `${part.width}ch`;
    }
    const outgoing = cell.children[0] as HTMLElement;
    const incoming = cell.children[1] as HTMLElement | undefined;
    const push = incoming && y < LATCH_CONTACT_PX ? y - LATCH_CONTACT_PX : 0;
    outgoing.style.transform = push ? `translateY(${push}px)` : '';
    if (incoming) incoming.style.transform = `translateY(${y}px)`;
  });
}

// The entry timestamp doubles as its permalink handle. Its href is the
// entry's jump route within the current instance and project/action filter, so
// copy-link / middle-click / new-tab all deep-link to the card; a plain click
// scrolls the entry to the top of the flow and pushes that URL.
function renderTimeHandle(entryId: string, timeStr: string, opts: RenderOptions): HTMLElement {
  const href = referenceHref('entry', entryId, opts);
  const link = el('a', {
    className: 'em-time',
    href,
    title: 'Scroll to this entry',
    textContent: timeStr,
  });
  bindDisplay(link, opts, (node, current) => setDisplayText(node,
    document.documentElement.dataset.timelineLayout === 'stacked' ? formatStamp(entryId, current) : formatTime(entryId, current)));
  wireNavigationLink(link, () => opts.onEntryTimeClick(entryId));
  return link;
}

export function renderEntry(
  entry: Entry,
  opts: RenderOptions,
  container: HTMLElement,
  // Present on the first (latest) entry of a day. In the gutter, it shares
  // the margin's first line; in stacked layouts, it anchors the calendar.
  // `weekStart` marks the first entry of a Mon–Sun week — its divider
  // extends across the gutter as the week seam.
  marker?: { date: string; prev: string | null; weekStart?: boolean },
): HTMLElement {
  const card = el('article', { className: 'entry-card' });
  card.dataset.entryId = entry.meta.created;
  if (marker?.weekStart) card.classList.add('week-start');

  const margin = el('div', { className: 'entry-margin' });
  if (marker) margin.appendChild(renderDateMarker(marker.date, marker.prev, opts));

  const timeStr = formatTime(entry.meta.created, opts);
  if (timeStr) {
    margin.appendChild(renderTimeHandle(entry.meta.created, timeStr, opts));
  }

  card.appendChild(margin);

  const body = el('div', { className: 'entry-body' });

  const projectIds = entry.meta.projects || [];
  const actionIds = entry.meta.actions || [];

  if (projectIds.length > 0 || actionIds.length > 0) {
    const tagRow = renderCompactTagRow(projectIds, actionIds, opts);
    body.appendChild(tagRow);
  }

  const content = renderContent(entry.content, opts, weekFilePath(entry.weekFile));
  content.classList.add('entry-content');
  body.appendChild(content);

  card.appendChild(body);
  container.appendChild(card);
  return card;
}

function renderCompactTagRow(
  projectIds: string[],
  actionIds: string[],
  opts: RenderOptions,
): HTMLElement {
  const row = el('div', { className: 'entry-tag-row' });

  if (projectIds.length > 0) {
    const group = renderTagGroup('project', projectIds, opts);
    row.appendChild(group);
  }

  if (actionIds.length > 0) {
    const group = renderTagGroup('action', actionIds, opts);
    row.appendChild(group);
  }

  return row;
}

function renderTagGroup(
  type: 'project' | 'action',
  ids: string[],
  opts: RenderOptions,
): HTMLElement {
  const group = el('span', { className: 'tag-group', id: controlId('tag-group') });
  const autoExpand = type === 'project' ? opts.expandProjects : opts.expandActions;
  setTagGroupState(group, type, ids, opts, ids.length > 1 && autoExpand);
  return group;
}

function setTagGroupState(
  group: HTMLElement,
  type: 'project' | 'action',
  ids: string[],
  opts: RenderOptions,
  expanded: boolean,
): void {
  const retainFocus = group.contains(document.activeElement);
  group.innerHTML = '';
  group.classList.toggle('is-expanded', expanded);

  const count = expanded ? ids.length : 1;
  for (let i = 0; i < count; i++) {
    group.appendChild(filterTag(type, ids[i], opts));
  }

  if (ids.length <= 1) return;

  // The bubble past the shown tags: a collapse arrow when expanded, else the
  // +N count folding the rest behind it.
  const pill = el('button', {
    type: 'button',
    'aria-controls': group.id,
    'aria-expanded': String(expanded),
    'aria-label': expanded ? `Collapse ${type} tags` : `Show ${ids.length - 1} more ${type === 'project' ? 'projects' : 'actions'}`,
    className: `tag-bubble tag-bubble-${type}${expanded ? ' tag-bubble-collapse' : ''}`,
    textContent: expanded ? '←' : `+${ids.length - 1}`,
  });
  if (!expanded) {
    // The entities folded behind this bubble — carry their state onto it:
    // the active filter's bold, and the co-hover of a hidden entity when one
    // of its other references is hovered elsewhere (matched by `data-ref-hidden`).
    // The bubble stands in for the hidden active tag, so it also carries that
    // tag's mark classes — the fill it takes stays the fill the tag would
    // have (a closed entity's grey, a due one's ring); classes only, the
    // bubble's +N leaves no room for a glyph.
    const hidden = ids.slice(count);
    const activeHidden = hidden.find((id) => isActiveRef(opts, type, id));
    if (activeHidden !== undefined) {
      pill.classList.add('is-active');
      bindDisplay(pill, opts, (node, current) => {
        const marks = current.refMarks(type, activeHidden);
        applyMarks(node, marks, false);
        describeReference(node, `Hidden active ${type}: ${current.resolveName(type, activeHidden)}. ${referenceDescription(type, marks)}`);
      });
    }
    pill.dataset.refHidden = hidden.map((id) => `${type}:${id}`).join(' ');
    pill.title = ids.slice(1).map(id => opts.resolveName(type, id)).join(', ');
  }
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    setTagGroupState(group, type, ids, opts, !expanded);
  });
  group.appendChild(pill);
  if (retainFocus) pill.focus({ preventScroll: true });
}

// The status pill row — each pill a lifecycle state or an exception, worn in
// the entity-pill style: the type accent field carrying the same marks the
// entity's own chips wear (the due ring, the calendar-slot glyph, the closed mute
// and strike); an exception pill styles as an absence instead. No type icon —
// the title directly above already carries it. A stamped pill spells its
// absolute stamp on hover — the label carries the distance, the hover the
// calendar fact. Which pills, and why time rides some labels: see
// actionPills in instance.ts.
function statusPills(type: 'project' | 'action', read: (opts: RenderOptions) => SummaryPill[], opts: RenderOptions): HTMLElement {
  const row = el('div', { className: 'status-pills' });
  // Retain the slots even while absent: a clock correction can bring the
  // no-calendar exception back without replacing surviving labels.
  for (let index = 0; index < 3; index++) {
    const pill = el('div', { className: `status-pill tag-${type}` });
    const label = el('span', { className: 'tag-text' });
    pill.appendChild(label);
    bindDisplay(pill, opts, (node, current) => {
      const state = read(current)[index];
      node.hidden = !state;
      if (!state) return;
      node.classList.toggle('pill-exception', !!state.exception);
      node.title = state.hover ? `${state.hover.prefix} ${formatScheduledStamp(state.hover.stamp, state.hover.timezone, current)}${state.hover.suffix ?? ''}` : '';
      setDisplayText(label, state.label);
      applyMarks(node, state.marks);
    });
    row.appendChild(pill);
    const annotation = el('span', { className: 'schedule-time' });
    bindDisplay(annotation, opts, (node, current) => {
      const hover = read(current)[index]?.hover;
      node.hidden = !hover?.timezone;
      if (hover?.timezone) setDisplayText(node, formatScheduledStamp(hover.stamp, hover.timezone, current));
    });
    row.appendChild(annotation);
  }
  return row;
}

// A clickable entity tag filtering the flow to the entity — the related
// sections' standard row.
function filterTag(type: 'project' | 'action' | 'entry', id: string, opts: RenderOptions): HTMLElement {
  const tag = renderTag(type, id, opts, (src) => opts.onTagClick({ type, id }, src));
  if (type === 'action' && id.startsWith('~')) tag.appendChild(el('span', { className: 'pill', textContent: 'Projected' }));
  return tag;
}

// Each row hangs on a rail (drawn by the timeline-list CSS) behind a fixed
// date gutter; the date prints only where it changes, so a run of same-dated
// rows reads as one stretch of time.
function timelineRows(rows: { stamp?: string; row: HTMLElement }[], opts: RenderOptions): HTMLElement[] {
  let prev: string | undefined;
  return rows.map(({ stamp, row }, index) => {
    const label = stamp ? relativeDate(stamp, opts.nowDate) : '';
    const wrap = el('span', { className: 'timeline-row' });
    wrap.appendChild(bindDisplay(el('span', { className: 'row-when', textContent: label === prev ? '' : label }), opts, (node, current) => {
      const value = stamp ? relativeDate(stamp, current.nowDate) : '';
      const previous = rows[index - 1]?.stamp;
      setDisplayText(node, index > 0 && value === (previous ? relativeDate(previous, current.nowDate) : '') ? '' : value);
    }));
    prev = label;
    wrap.appendChild(row);
    return wrap;
  });
}

// A dated section: all its rows on the chronological rail, defaulting to
// the week ahead and at least a few rows either side of now; the rest
// expands from either end ('+N earlier' / '+N later'), each direction
// recorded on the heading for panel-state replay. A tick on the rail marks
// now between the past and the future.
function appendDatedSection(sections: HTMLElement, title: string, entries: { id: string; stamp: string; timezone?: string }[], opts: RenderOptions): void {
  if (entries.length === 0) return;
  const heading = el('h3', { className: 'related-heading', textContent: title });
  heading.appendChild(el('span', { className: 'heading-count', textContent: String(entries.length) }));
  heading.dataset.section = title;
  sections.appendChild(heading);

  let { from, to } = timelineWindow(entries, opts.nowDate);
  let labels = entries.map((e) => relativeDate(e.stamp, opts.nowDate, e.timezone));
  const lis = entries.map(({ id, stamp, timezone }, i) => {
    const wrap = el('span', { className: 'timeline-row' });
    // The window edge always prints its date, even mid-run — the row that
    // carried it may be folded away.
    wrap.appendChild(bindDisplay(el('span', { className: 'row-when' }), opts, (node, current) => {
      const value = relativeDate(stamp, current.nowDate, timezone);
      const first = heading.dataset.expanded?.includes('past') ? 0 : from;
      const previous = entries[i - 1];
      setDisplayText(node, i !== first && previous && value === relativeDate(previous.stamp, current.nowDate, previous.timezone) ? '' : value);
    }));
    wrap.appendChild(filterTag('action', id, opts));
    if (timezone && stamp.includes('T')) wrap.appendChild(scheduleAnnotation(stamp, timezone, opts));
    // Still-ahead rows carry the now color on their stretch of the rail —
    // split by the full stamp, so today's later times sit with the future.
    const future = stampInstant({ stamp, timezone }) > clockInstant(opts.nowDate);
    return el('li', { className: `related-item${future ? ' timeline-future' : ''}` }, [wrap]);
  });

  const expand = (dir: 'future' | 'past', count: number, reveal: () => void) => {
    if (count === 0) return;
    const more = el('button', { type: 'button', className: 'related-more timeline-more', 'aria-expanded': 'false', 'aria-controls': list.id, 'aria-label': `Show ${count} ${dir === 'future' ? 'later' : 'earlier'} ${title}`, textContent: `+${count} ${dir === 'future' ? 'later' : 'earlier'}` });
    more.dataset.section = title;
    more.dataset.dir = dir;
    more.addEventListener('click', () => {
      const retainFocus = document.activeElement === more;
      const first = dir === 'past' ? lis[0] : lis[to];
      more.setAttribute('aria-expanded', 'true');
      more.remove();
      heading.dataset.expanded = heading.dataset.expanded ? `${heading.dataset.expanded} ${dir}` : dir;
      reveal();
      refreshRevealed(list, opts);
      if (retainFocus) first?.querySelector<HTMLElement>('a, button')?.focus();
    });
    sections.appendChild(more);
  };

  const list = el('ul', { className: 'related-list timeline-list', id: controlId('timeline-list') });
  for (const li of lis.slice(from, to)) list.appendChild(li);
  // The tick sits after the past rows, before the still-ahead's (a
  // date-only stamp counts from its day's start); it never folds (the
  // hidden ends lie strictly beyond it). The CSS keys the tick row's rail
  // split on this adjacency (.timeline-now:has(+ .timeline-future)).
  let nowAt = entries.findIndex((e) => stampInstant(e) > clockInstant(opts.nowDate));
  if (nowAt === -1) nowAt = entries.length;
  nowAt = Math.max(nowAt, from);
  const tick = el('li', { className: 'related-item timeline-now' }, [
    el('span', { className: 'timeline-row' }, [el('span', { className: 'row-when', textContent: 'now' })]),
  ]);
  list.insertBefore(tick, nowAt < to ? lis[nowAt] : null);

  expand('past', from, () => {
    list.prepend(...lis.slice(0, from));
    // The revealed rows may continue their run into the old edge, whose
    // edge-printed date would then repeat mid-run — re-suppress it.
    if (from > 0 && labels[from] === labels[from - 1]) lis[from].querySelector('.row-when')!.textContent = '';
  });
  sections.appendChild(list);
  expand('future', lis.length - to, () => list.append(...lis.slice(to)));
  list.dataset.liveContainer = '';
  bindDisplay(list, opts, (_node, current) => {
    const previouslyVisibleEnd = to;
    const window = timelineWindow(entries, current.nowDate);
    from = Math.min(from, window.from);
    to = Math.max(to, window.to);
    labels = entries.map(e => relativeDate(e.stamp, current.nowDate, e.timezone));
    const start = heading.dataset.expanded?.includes('past') ? 0 : from;
    const end = heading.dataset.expanded?.includes('future') ? lis.length : to;
    for (let i = start; i < end; i++) {
      if (lis[i].parentElement !== list) {
        const next = lis.slice(i + 1).find(row => row.parentElement === list) ?? null;
        list.insertBefore(lis[i], next);
        refreshRevealed(lis[i], current);
      }
      lis[i].classList.toggle('timeline-future', stampInstant(entries[i]) > clockInstant(current.nowDate));
    }
    const next = lis.slice(start, end).find((_, i) => stampInstant(entries[start + i]) > clockInstant(current.nowDate)) ?? null;
    moveDisplayNode(tick, next, list, current.liveDurationMs ?? 0);
    for (const button of Array.from(sections.querySelectorAll<HTMLElement>('button[data-dir]'))) {
      if (button.dataset.section !== title) continue;
      const count = button.dataset.dir === 'past' ? from : lis.length - to;
      if (count === 0 && document.activeElement === button) {
        const revealed = lis[button.dataset.dir === 'past' ? from : previouslyVisibleEnd];
        revealed?.querySelector<HTMLElement>('a, button')?.focus({ preventScroll: true });
      }
      button.hidden = count === 0;
      setDisplayText(button, `+${count} ${button.dataset.dir === 'past' ? 'earlier' : 'later'}`);
      button.setAttribute('aria-label', `Show ${count} ${button.dataset.dir === 'past' ? 'earlier' : 'later'} ${title}`);
    }
  });
}

// The open-work sections every scope's panel shares: Scheduled on the dated
// rail with the now tick and week-ahead window; Backlog by last update,
// longest-quiet first — going quiet attracts attention — folding its
// freshest rows instead of its tail. A deadline never regroups an action —
// the chip's due ring carries it.
function appendOpenActionSections(sections: HTMLElement, actions: OpenActionGroups, opts: RenderOptions): HTMLElement {
  const container = el('div');
  sections.appendChild(container);
  sections = container;
  appendDatedSection(sections, 'Scheduled', actions.scheduled.map((a) => ({ id: a.id, stamp: a.scheduled, timezone: a.timezone })), opts);
  appendSection(sections, 'Backlog', timelineRows(actions.backlog.map((a) =>
    ({ stamp: a.updated, row: filterTag('action', a.id, opts) })), opts), 'timeline-list', true, 'later');
  for (const issue of actions.issues ?? []) sections.appendChild(el('p', { textContent: issue }));
  if (actions.loadMore) {
    const more = el('button', { type: 'button', className: 'related-more', textContent: 'Load more recurrence history' });
    more.addEventListener('click', async () => {
      more.disabled = true;
      try {
        const next = await actions.loadMore!();
        if (!container.isConnected) return;
        const expanded = [...container.querySelectorAll<HTMLElement>('.related-heading[data-expanded]')].map(heading => ({ section: heading.dataset.section, dirs: heading.dataset.expanded!.split(' ') }));
        const focused = document.activeElement === more;
        const scroller = container.closest<HTMLElement>('#side-panel-body'), scrollTop = scroller?.scrollTop;
        const replacement = appendOpenActionSections(container.parentElement!, next, opts);
        container.replaceWith(replacement);
        for (const { section, dirs } of expanded) for (const dir of dirs) {
          [...replacement.querySelectorAll<HTMLButtonElement>('button[data-section][data-dir]')].find(button => button.dataset.section === section && button.dataset.dir === dir)?.click();
        }
        if (scroller && scrollTop !== undefined) scroller.scrollTop = scrollTop;
        if (focused) replacement.querySelector<HTMLElement>('button:not([hidden]), a')?.focus({ preventScroll: true });
      }
      catch { more.disabled = false; more.textContent = 'Retry loading recurrence history'; }
    });
    sections.appendChild(more);
  }
  return container;
}

// The Assets section: linked files on the rail, most recently linked first;
// a body-only link has no linking entry and rides undated at the tail.
function appendAssetSection(sections: HTMLElement, assets: { path: string; title: string; updated?: string }[], opts: RenderOptions): void {
  appendSection(sections, 'Assets', timelineRows(assets.map((a) =>
    ({ stamp: a.updated, row: renderAssetRow({ path: a.path, title: a.title }, opts) })), opts), 'timeline-list', true);
}

// The scope's counts for the stats row: open/total pairs for the lifecycle
// kinds it relates to, a bare count for entries. Zero is a stat, never
// hidden; a scope omits only the kinds it has no notion of (an action
// counts no actions — the pills carry its own state).
export interface ScopeStats {
  projects?: { open: number; total: number };
  actions?: { open: number; total: number };
  entries: number;
}

// The one muted facts line closing the header below the description —
// reading as text, it belongs with the prose: the stats — icon-and-count
// pairs, the type icon in its full color, the count in the mono face — then
// `updated <distance> ago` trailing them in the text face, the one
// time-since fact a summary states (absent when no entry mentions the
// entity; the pills above stay pure status). Informational only, the
// sections below navigate. Each pair spells itself out on hover.
export function renderFactsLine(stats: ScopeStats, updated: string | undefined, opts: RenderOptions): HTMLElement {
  const row = el('div', { className: 'summary-facts' });
  const pair = (type: 'project' | 'action' | 'entry', text: string, label: string) => {
    const item = el('span', { className: 'summary-stat', title: label });
    const icon = el('span', { className: `stat-icon icon-${type}` });
    setIcon(icon, type);
    item.append(icon, el('span', { className: 'stat-count', textContent: text }));
    row.appendChild(item);
  };
  const openTotal = (type: 'project' | 'action', kind: string, c: { open: number; total: number }) =>
    pair(type, `${c.open}/${c.total}`, `${c.open} of ${c.total} ${c.total === 1 ? kind : `${kind}s`} open`);
  if (stats.projects) openTotal('project', 'project', stats.projects);
  if (stats.actions) openTotal('action', 'action', stats.actions);
  pair('entry', String(stats.entries), `${stats.entries} ${stats.entries === 1 ? 'entry' : 'entries'}`);
  if (updated) row.appendChild(bindDisplay(el('span', { className: 'facts-updated' }), opts, (node, current) => setDisplayText(node, `updated ${ago(updated, current.nowDate)}`)));
  return row;
}

// The side panel summary — identity, the status pills, the authored index
// description, and the facts line closing the header, then the scope's
// related sections — never the full record; the detail opens in the reader
// via the title's open-arrow.
function renderSummary(
  type: 'project' | 'action',
  name: string,
  pills: HTMLElement,
  description: string | undefined,
  opts: RenderOptions,
  updated: string | undefined,
  stats: ScopeStats,
  sections: HTMLElement,
  onOpenDetail: () => void,
): HTMLElement {
  const container = el('div', { className: `entity-view ${type}-summary` });
  container.appendChild(renderEntityTitle(type, name, onOpenDetail, opts.routeHref(buildRoute({ filter: opts.activeFilter, doc: { kind: 'detail' } }))));
  container.appendChild(pills);
  if (description) container.appendChild(el('p', { className: 'summary-description', textContent: description }));
  container.appendChild(renderFactsLine(stats, updated, opts));
  container.appendChild(sections);
  return container;
}

// A filtered scope's panel data — the instance panel's live-state sections
// scoped to the entity, plus the sections only it has. Closed and resolved
// work reads in the filtered flow and the detail's census, never here. The
// scope's project rows stay off the rail — a short, near-static list has no
// temporal story to draw — so they carry ids only, most recently active
// first.
export interface ProjectSummaryData {
  // The project's open actions (co-occurrence), grouped by date kind.
  actions: OpenActionGroups;
  // The explicit related_projects, both directions; the link's description
  // and direction read in the detail's hierarchy tree, not in the rows.
  related: string[];
  // Files linked from the project's entries or body, most recently linked
  // first.
  assets: { path: string; title: string; updated?: string }[];
  // The latest entry mentioning the project — the updated line.
  updated?: string;
  // Related projects and co-occurring actions open/total, entries mentioning
  // the project.
  stats: ScopeStats;
}

export function renderProjectSummary(
  project: Project,
  description: string | undefined,
  opts: RenderOptions,
  data: ProjectSummaryData,
  onOpenDetail: () => void,
): HTMLElement {
  const fm = project.frontMatter;
  const sections = el('div', { className: 'entity-related' });
  appendOpenActionSections(sections, data.actions, opts);
  appendSection(sections, 'Related projects', data.related.map((id) => filterTag('project', id, opts)), undefined, true);
  appendAssetSection(sections, data.assets, opts);
  return renderSummary('project', fm.name, statusPills('project', () => projectPills(fm), opts), description,
    opts, data.updated, data.stats, sections, onOpenDetail);
}

export interface ActionSummaryData {
  projected?: boolean;
  // Co-occurring projects, most recently active first.
  projects: string[];
  assets: { path: string; title: string; updated?: string }[];
  updated?: string;
  // Co-occurring projects open/total and entries mentioning the action.
  stats: ScopeStats;
}

export function renderActionSummary(
  action: Action,
  description: string | undefined,
  opts: RenderOptions,
  data: ActionSummaryData,
  onOpenDetail: () => void,
): HTMLElement {
  const fm = action.frontMatter;
  const sections = el('div', { className: 'entity-related' });
  appendSection(sections, 'Projects', data.projects.map((id) => filterTag('project', id, opts)), undefined, true);
  appendAssetSection(sections, data.assets, opts);
  return renderSummary('action', fm.name, statusPills('action', current => [...(data.projected ? [{ label: 'Projected', marks: [] }] : []), ...actionPills(fm, current.nowDate)], opts), description,
    opts, data.updated, data.stats, sections, onOpenDetail);
}

// What the instance summary shows: the open work, grouped and ordered by
// what needs attention (see src/instance.ts for the grouping).
export interface InstanceSummaryData {
  // Open projects, most recently active first, with the latest entry's
  // stamp (absent when no entry mentions the project).
  projects: { id: string; updated?: string }[];
  actions: OpenActionGroups;
  // Every asset linked from any entry, most recently linked first, dated by
  // the latest entry linking it.
  assets: { path: string; updated: string }[];
  // The instance's newest entry, for the updated line; absent when there
  // are no entries.
  latest?: string;
  // Instance-wide: all projects and actions open/total, all entries.
  stats: ScopeStats;
}

// The instance summary — the side panel of the unfiltered flow: the manifest's
// name and description, then the instance's current state — open projects by
// recent activity, the shared open-work sections, and the linked assets.
// Project rows read reverse chronologically by their last update — latest
// first, like the flow.
export function renderInstanceSummary(
  manifest: Manifest,
  opts: RenderOptions,
  data: InstanceSummaryData,
  onOpenDetail: () => void,
): HTMLElement {
  const container = el('div', { className: 'entity-view instance-summary' });
  container.appendChild(renderEntityTitle('instance', manifest.name ?? manifest.id, onOpenDetail, opts.routeHref(buildRoute({ filter: null, doc: { kind: 'detail' } }))));
  if (manifest.description) container.appendChild(el('p', { className: 'summary-description', textContent: manifest.description }));
  container.appendChild(renderFactsLine(data.stats, data.latest, opts));

  const sections = el('div', { className: 'entity-related' });
  appendSection(sections, 'Open projects', timelineRows(data.projects.map((p) =>
    ({ stamp: p.updated, row: filterTag('project', p.id, opts) })), opts), 'timeline-list', true);
  appendOpenActionSections(sections, data.actions, opts);
  appendAssetSection(sections, data.assets.map((a) =>
    ({ path: a.path, title: assetDisplayName(a.path), updated: a.updated })), opts);
  container.appendChild(sections);
  return container;
}

// A small open-arrow, deliberately unlike the boxy type badges — two similar
// glyphs bracketing the name read as a symmetric pair; an arrow reads as the
// action it is.
const OPEN_DETAIL_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7h10v10"/><path d="M7 17 17 7"/></svg>';

// Title with a type icon in front — colored by type so the entity kind reads
// at a glance without a labeled header. With `onOpenDetail` the whole title —
// icon and name — is one control opening the scope's record in the reader, a
// muted open-arrow (↗) trailing the name as the affordance, superscript like
// an external-link marker: the control is the identity it opens, keeping
// content rows free of controls. The arrow rides the last word inline, so it
// follows a wrapped title naturally.
function renderEntityTitle(
  type: 'project' | 'action' | 'entry' | 'asset' | 'instance',
  name: string,
  onOpenDetail?: () => void,
  href?: string,
): HTMLElement {
  const title = el('h2', { className: 'entity-title' });
  const icon = el('span', { className: `entity-title-icon icon-${type}`, title: type });
  setIcon(icon, type);
  const label = el('span', { className: 'entity-title-label', textContent: name });
  if (onOpenDetail) {
    const btn = el('a', { className: 'title-open', href: href!, title: 'Open details', 'aria-label': `Open details for ${name}` });
    const arrow = el('span', { className: 'title-detail', 'aria-hidden': 'true' });
    arrow.innerHTML = OPEN_DETAIL_ICON; // hardcoded SVG only — never user data
    btn.append(icon, label, arrow);
    wireNavigationLink(btn, onOpenDetail);
    title.appendChild(btn);
  } else {
    title.append(icon, label);
  }
  return title;
}

// A field's optional `mono` flag marks a code-like value (an id, a version,
// a config entry) — rendered in the mono face; prose and dates stay in the
// text face.
export type FieldValue = string | ((opts: RenderOptions) => string);
function renderFields(pairs: [string, FieldValue, boolean?][], opts?: RenderOptions): HTMLElement {
  const fields = el('dl', { className: 'detail-fields' });
  for (const [dt, dd, mono] of pairs) {
    fields.appendChild(el('dt', { textContent: dt }));
    const value = el('dd', { className: mono ? 'field-mono' : '', textContent: typeof dd === 'string' ? dd : dd(opts!) });
    if (typeof dd === 'function') bindDisplay(value, opts!, (node, current) => setDisplayText(node, dd(current)));
    fields.appendChild(value);
  }
  return fields;
}

// The detail views render the complete record: the authored index
// description (the panel summary's line), every front matter field (absent
// fields omitted, the id leading them, dates via formatStamp), then the
// body. `name` is the title and `resolution` the status pills — each datum
// appears exactly once. A project's related_projects render as its place in
// the hierarchy — a tree, so position carries the link direction.
// Actions grouped by state, index order, with index descriptions — the
// census shape the instance and project details share.
export type ActionCensus = Record<'open' | 'done' | 'cancelled', { id: string; description?: string }[]>;

// The census as foldable sections, empty groups omitted; the resolved
// groups start folded, their counts still readable.
function appendActionCensus(container: HTMLElement, actions: ActionCensus, opts: RenderOptions): void {
  const groups: [keyof ActionCensus, string, boolean][] = [
    ['open', 'Open actions', true],
    ['done', 'Done actions', false],
    ['cancelled', 'Cancelled actions', false],
  ];
  for (const [key, title, open] of groups) {
    const items = actions[key];
    if (items.length === 0) continue;
    container.appendChild(renderFoldSection(title, items.length, open,
      relatedList(items.map((a) => renderTagRow('action', a.id, a.description, opts)))));
  }
}

// The derived record on a project detail: its action census and its stats.
export interface ProjectDetailData {
  actions: ActionCensus;
  stats: [string, FieldValue][];
}

export function renderProjectDetail(id: string, project: Project, description: string | undefined, opts: RenderOptions, hierarchy: HierarchyNode[], data: ProjectDetailData): HTMLElement {
  const container = el('div', { className: 'entity-view entity-detail' });
  const fm = project.frontMatter;
  container.appendChild(renderEntityTitle('project', fm.name));
  container.appendChild(statusPills('project', () => projectPills(fm), opts));
  if (description) container.appendChild(el('p', { className: 'summary-description', textContent: description }));

  const fields: [string, FieldValue, boolean?][] = [['ID', id, true], ['Created', current => formatStamp(fm.created, current)]];
  if (fm.ended) fields.push(['Ended', current => formatStamp(fm.ended!, current)]);
  container.appendChild(renderFields(fields, opts));

  const derived = el('div', { className: 'entity-related' });
  if (hierarchy.length) {
    derived.appendChild(el('h3', { className: 'related-heading', textContent: 'Project hierarchy' }));
    derived.appendChild(renderHierarchyList(hierarchy, opts));
  }
  appendActionCensus(derived, data.actions, opts);
  derived.appendChild(renderFoldSection('Stats', null, true, renderFields(data.stats, opts)));
  container.appendChild(derived);

  if (project.body) {
    const content = renderContent(project.body, opts, entityFilePath('project', id));
    content.classList.add('detail-body');
    container.appendChild(content);
  }
  return container;
}

export function renderActionDetail(id: string, action: Action, description: string | undefined, opts: RenderOptions, stats: [string, FieldValue][]): HTMLElement {
  const container = el('div', { className: 'entity-view entity-detail' });
  const fm = action.frontMatter;
  container.appendChild(renderEntityTitle('action', fm.name));
  container.appendChild(statusPills('action', current => [...(id.startsWith('~') ? [{ label: 'Projected', marks: [] }] : []), ...actionPills(fm, current.nowDate)], opts));
  if (description) container.appendChild(el('p', { className: 'summary-description', textContent: description }));

  const fields: [string, FieldValue, boolean?][] = id.startsWith('~') ? [] : [['ID', id, true], ['Created', current => formatStamp(fm.created, current)]];
  if (fm.occurrence) { fields.push(['Template', fm.occurrence.template], ['Original occurrence', current => formatScheduledStamp(fm.occurrence!.original, fm.occurrence!.timezone, current)]); }
  for (const schedule of Array.isArray(fm.recurrence) ? fm.recurrence : []) {
    if (schedule && typeof schedule.dtstart === 'string' && typeof schedule.rrule === 'string') fields.push(['Recurrence', current => `${formatScheduledStamp(schedule.dtstart, schedule.timezone, current)} · ${schedule.rrule}`]);
  }
  if (fm.scheduled) {
    fields.push(['Scheduled', current => formatScheduledStamp(fm.scheduled!, fm.timezone, current)]);
  }
  if (fm.duration) fields.push(['Duration', fm.duration]);
  if (fm.calendar) fields.push(['Calendar', fm.calendar_account ? `${fm.calendar} (${fm.calendar_account})` : fm.calendar]);
  if (fm.deadline) fields.push(['Deadline', current => formatStamp(fm.deadline!, current)]);
  container.appendChild(renderFields(fields, opts));

  const derived = el('div', { className: 'entity-related' });
  derived.appendChild(renderFoldSection('Stats', null, true, renderFields(stats, opts)));
  container.appendChild(derived);

  if (action.body) {
    const content = renderContent(action.body, opts, entityFilePath('action', id.startsWith('~') ? action.frontMatter.occurrence!.template : id));
    content.classList.add('detail-body');
    container.appendChild(content);
  }
  return container;
}

// The instance's full census, shown on its detail — everything there is,
// including closed and resolved work.
export interface InstanceDetailData {
  // The whole hierarchy forest, every project on it.
  projects: HierarchyNode[];
  // All actions by state.
  actions: ActionCensus;
  // Instance-wide numbers, label/value pairs.
  stats: [string, FieldValue][];
}

// A foldable detail section: a related-style heading that discloses its
// content, the count (when given) staying readable while folded. Native
// <details>, so keyboard and a11y come free.
function renderFoldSection(title: string, count: number | null, open: boolean, content: HTMLElement): HTMLElement {
  const details = el('details', { className: 'detail-section' });
  if (open) details.setAttribute('open', '');
  const summary = el('summary', { className: 'related-heading', textContent: title });
  if (count != null) summary.appendChild(el('span', { className: 'heading-count', textContent: String(count) }));
  details.appendChild(summary);
  details.appendChild(content);
  return details;
}

function relatedList(rows: HTMLElement[]): HTMLElement {
  const list = el('ul', { className: 'related-list' });
  appendRelatedItems(list, rows);
  return list;
}

// The instance detail: the manifest's complete record — `name` is the title,
// `description` the summary line beneath it, the other front matter fields
// following (the id leading them, config keys under their `config.` path) —
// then the full census in foldable sections (resolved actions start folded;
// their counts still read), and the free-form body (the user-authored agent
// instructions).
export function renderInstanceDetail(
  manifest: Manifest,
  body: string,
  opts: RenderOptions,
  data: InstanceDetailData,
): HTMLElement {
  const container = el('div', { className: 'entity-view entity-detail' });
  container.appendChild(renderEntityTitle('instance', manifest.name ?? manifest.id));
  if (manifest.description) container.appendChild(el('p', { className: 'summary-description', textContent: manifest.description }));

  const fields: [string, FieldValue, boolean?][] = [['ID', manifest.id, true]];
  if (manifest.version) fields.push(['Version', manifest.version, true]);
  for (const [key, value] of Object.entries(manifest.config ?? {})) {
    fields.push([`config.${key}`, String(value), true]);
  }
  container.appendChild(renderFields(fields, opts));

  const census = el('div', { className: 'entity-related' });
  // Distinct projects, not rows — a project reached twice repeats as a leaf.
  const ids = new Set<string>();
  const collect = (nodes: HierarchyNode[]) => nodes.forEach((n) => { ids.add(n.id); collect(n.children); });
  collect(data.projects);
  if (data.projects.length) {
    census.appendChild(renderFoldSection('Projects', ids.size, true,
      renderHierarchyList(data.projects, opts)));
  }
  appendActionCensus(census, data.actions, opts);
  census.appendChild(renderFoldSection('Stats', null, true, renderFields(data.stats, opts)));
  container.appendChild(census);

  if (body) {
    const content = renderContent(body, opts, 'aside.md');
    content.classList.add('detail-body');
    container.appendChild(content);
  }
  return container;
}

// A related-entity row: clickable tag plus an optional muted description.
function renderTagRow(
  type: 'project' | 'action' | 'entry',
  id: string,
  description: string | undefined,
  opts: RenderOptions,
): HTMLElement {
  const row = el('span', { className: 'related-row' });
  row.appendChild(filterTag(type, id, opts));
  if (description) row.appendChild(el('span', { className: 'related-desc', textContent: ` — ${description}` }));
  return row;
}

// Wrap each row in the <li> shared by every related list.
function appendRelatedItems(list: HTMLElement, items: HTMLElement[]): void {
  for (const item of items) list.appendChild(el('li', { className: 'related-item' }, [item]));
  refreshRevealed(list);
}

// The project hierarchy as nested related lists: ancestor paths above the
// open project, its descendant subtree below. Rows are the usual clickable
// tags — the open project carries the active-filter fill (a doc opens over
// its own filter) — with the link's declared description muted after the tag.
function renderHierarchyList(nodes: HierarchyNode[], opts: RenderOptions): HTMLElement {
  const list = el('ul', { className: 'related-list hierarchy-list' });
  for (const node of nodes) {
    const item = el('li', { className: 'related-item' }, [renderTagRow('project', node.id, node.description, opts)]);
    if (node.children.length) item.appendChild(renderHierarchyList(node.children, opts));
    list.appendChild(item);
  }
  return list;
}

// A titled list of related rows, shared by the summary and document views.
function renderRelatedList(title: string, rows: HTMLElement[]): HTMLElement {
  const container = el('div', { className: 'entity-related' });
  container.appendChild(el('h3', { className: 'related-heading', textContent: title }));
  const list = el('ul', { className: 'related-list' });
  appendRelatedItems(list, rows);
  container.appendChild(list);
  return container;
}

// A titled list of rows appended to `container`; empty sections are omitted.
// Long lists collapse behind a fold hiding the given array's tail — keeping
// one busy section from burying the others. `tail` names the hidden end:
// "+N earlier" on a reverse-chrono list (the store's Relations guarantee —
// the tail is the older rows), "+N later" on the one stalest-first list
// (the Backlog sections, whose tail is the freshest). A click
// reveals the next BATCH rows, the button's count ticking down until the
// tail is out — an enormous list never pastes in whole. The heading and the
// fold button both carry data-section so the app can find a section's fold
// control by title and replay its expanded state when navigation restores
// the panel; the heading records the reveal count (data-section stays the
// bare title even when the heading shows a count).
function appendSection(container: HTMLElement, title: string, items: HTMLElement[], listClass?: string, count = false, tail: 'earlier' | 'later' = 'earlier'): void {
  const VISIBLE = 8;
  const BATCH = 20;
  if (items.length === 0) return;
  const heading = el('h3', { className: 'related-heading', textContent: title });
  if (count) heading.appendChild(el('span', { className: 'heading-count', textContent: String(items.length) }));
  heading.dataset.section = title;
  container.appendChild(heading);
  const list = el('ul', { className: listClass ? `related-list ${listClass}` : 'related-list', id: controlId('related-list') });
  appendRelatedItems(list, items.slice(0, VISIBLE));
  container.appendChild(list);
  if (items.length > VISIBLE) {
    let shown = VISIBLE;
    const more = el('button', { type: 'button', className: `related-more${listClass ? ' timeline-more' : ''}`, 'aria-expanded': 'false', 'aria-controls': list.id, 'aria-label': `Show more ${title}, ${items.length - VISIBLE} ${tail} remaining`, textContent: `+${items.length - VISIBLE} ${tail}` });
    more.dataset.section = title;
    more.addEventListener('click', () => {
      const retainFocus = document.activeElement === more;
      const first = items[shown];
      more.setAttribute('aria-expanded', 'true');
      appendRelatedItems(list, items.slice(shown, shown + BATCH));
      shown += BATCH;
      heading.dataset.expanded = String(Number(heading.dataset.expanded ?? '0') + 1);
      if (shown >= items.length) {
        more.remove();
      } else {
        more.textContent = `+${items.length - shown} ${tail}`;
        more.setAttribute('aria-label', `Show more ${title}, ${items.length - shown} ${tail} remaining`);
      }
      if (retainFocus) (first.matches('a, button') ? first : first.querySelector<HTMLElement>('a, button'))?.focus();
    });
    container.appendChild(more);
  }
}

// An asset row — file icon and link title, opening the reader; shared by the
// related lists and the instance summary's Assets timeline.
function renderAssetRow(asset: AssetLink, opts: RenderOptions): HTMLElement {
  const row = el('a', { className: 'related-row asset-row', title: asset.path, href: opts.routeHref(buildRoute({ filter: opts.activeFilter, doc: { kind: 'asset', path: asset.path } })) });
  setIcon(row, 'asset');
  row.appendChild(el('span', { className: 'asset-row-title', textContent: asset.title }));
  wireNavigationLink(row, () => opts.onAssetClick(asset.path));
  return row;
}

// The entry detail's links as plain lists — the tags all share the entry's
// own moment, so no rail dates them.
function renderRelatedSections(rel: EntityRelations, opts: RenderOptions): HTMLElement {
  const container = el('div', { className: 'entity-related' });
  appendSection(container, 'Projects', (rel.projects ?? []).map((id) => filterTag('project', id, opts)));
  appendSection(container, 'Actions', (rel.actions ?? []).map((id) => filterTag('action', id, opts)));
  appendSection(container, 'Assets', (rel.assets ?? []).map((asset) => renderAssetRow(asset, opts)));
  return container;
}

// The entry detail page: an entry's full content plus its links. Reached by
// the #entry/<id> URL — in-app entry references jump in the flow instead.
export function renderEntryDetail(entry: Entry, opts: RenderOptions, rel?: EntityRelations): HTMLElement {
  const container = el('div', { className: 'entity-view entry-detail' });
  const title = renderEntityTitle('entry', opts.resolveName('entry', entry.meta.created));
  bindDisplay(title.querySelector<HTMLElement>('.entity-title-label')!, opts, (node, current) => setDisplayText(node, current.resolveName('entry', entry.meta.created)));
  container.appendChild(title);
  const body = renderContent(entry.content, opts, weekFilePath(entry.weekFile));
  body.classList.add('detail-body');
  container.appendChild(body);
  if (rel) container.appendChild(renderRelatedSections(rel, opts));
  return container;
}

// The reader payload for an asset, resolved by the caller: media kinds carry a
// URL to embed, markdown/text carry the file's content, binary carries a URL to
// download (or null when the source can't address it).
export type AssetContent =
  | { kind: 'markdown' | 'text'; text: string }
  | { kind: 'image' | 'pdf' | 'audio' | 'video' | 'webpage'; url: string }
  | { kind: 'webpage'; text: string }
  | { kind: 'binary'; url: string | null };

export interface ArtifactRelations {
  projects: string[];
  actions: string[];
  backlinks: string[];
}

function artifactBacklink(handle: string, opts: RenderOptions): HTMLElement {
  const artifact = validArtifactReference(handle);
  if (artifact) {
    const anchor = artifactLink(artifact.id, artifact.filename, opts);
    const label = el('span', { className: 'tag-text', textContent: anchor.textContent ?? '' });
    anchor.classList.add('tag', 'tag-artifact');
    setIcon(anchor, 'artifact');
    anchor.appendChild(label);
    return anchor;
  }
  const ref = /^#(project|action|entry)\/(.+)$/.exec(handle);
  if (!ref) return el('span', { textContent: handle });
  const type = ref[1] as 'project' | 'action' | 'entry';
  const id = ref[2];
  const anchor = refChip(type, id, opts, `tag tag-${type}`);
  anchor.title = handle;
  wireNavigationLink(anchor, () => opts.onTagClick({ type, id }, anchor));
  return anchor;
}

// Artifacts use the file reader: Markdown content or a sole attachment,
// with stable identity and the references that provide its context.
export function renderArtifactDetail(
  id: string,
  artifact: Artifact,
  description: string | undefined,
  opts: RenderOptions,
  relations: ArtifactRelations = { projects: [], actions: [], backlinks: [] },
  content?: AssetContent,
  filename?: string,
): HTMLElement {
  const container = el('div', { className: 'entity-view asset-detail artifact-detail' });
  container.appendChild(el('h2', { className: 'entity-title', textContent: filename ?? artifact.frontMatter.name }));
  if (filename) {
    const parent = el('div', { className: 'artifact-parent' });
    parent.appendChild(artifactLink(id, undefined, opts, artifact.frontMatter.name));
    container.appendChild(parent);
  }
  container.appendChild(el('div', { className: 'asset-path', textContent: artifactHandle(id, filename) }));
  if (!filename && description) {
    container.appendChild(el('p', { className: 'summary-description', textContent: description }));
  }

  const target = filename ?? artifactContentFilename(artifact);
  if (target && content) {
    container.appendChild(renderAssetBody(artifactAttachmentRelativePath(id, target), content, opts, true));
  } else {
    const body = renderContent(artifact.body, opts, artifactRecordPath(id));
    body.classList.add('detail-body');
    container.appendChild(body);
  }

  const related = el('div', { className: 'entity-related' });
  if (!filename) {
    appendSection(related, 'Attachments', (artifact.frontMatter.attachments ?? [])
      .map((attachment) => artifactLink(id, attachment, opts)));
  }
  appendSection(related, 'Projects', relations.projects.map((project) => filterTag('project', project, opts)));
  appendSection(related, 'Actions', relations.actions.map((action) => filterTag('action', action, opts)));
  appendSection(related, 'Linked from', relations.backlinks.map((handle) => artifactBacklink(handle, opts)));
  container.appendChild(related);
  return container;
}

// An asset is a plain file — its body is embedded, markdown-rendered, or shown
// verbatim per its kind, with the entries that link to it listed for context.
export function renderAssetDetail(
  path: string,
  content: AssetContent,
  opts: RenderOptions,
  linkedFrom: { id: string; description?: string }[],
): HTMLElement {
  const container = el('div', { className: 'entity-view asset-detail' });
  container.appendChild(el('h2', { className: 'entity-title', textContent: assetDisplayName(path) }));
  container.appendChild(el('div', { className: 'asset-path', textContent: path }));
  container.appendChild(renderAssetBody(path, content, opts));

  if (linkedFrom.length > 0) {
    container.appendChild(renderRelatedList('Linked from',
      linkedFrom.map((entry) => renderTagRow('entry', entry.id, entry.description, opts))));
  }

  return container;
}

function renderAssetBody(path: string, content: AssetContent, opts: RenderOptions, stripFrontMatter = false): HTMLElement {
  const name = assetDisplayName(path);
  const watchMedia = <T extends HTMLElement>(media: T, kind: string): T => {
    media.addEventListener('error', () => {
      const error = kind === 'audio' || kind === 'video' ? (media as unknown as HTMLMediaElement).error : null;
      const reason = error ? ({ 1: 'playback was aborted', 2: 'media could not load', 3: 'media could not be decoded', 4: 'media format is unsupported' }[error.code] ?? 'media preview failed')
        : `${kind} could not load or be decoded`;
      opts.onMediaError?.(path, new Error(`Could not preview ${path}: ${reason}`), media);
    }, { once: true });
    return media;
  };
  switch (content.kind) {
    case 'markdown': {
      const body = renderContent(stripFrontMatter ? splitFrontMatter(content.text).body : content.text, opts, path);
      body.classList.add('detail-body');
      return body;
    }
    case 'text': {
      const pre = el('pre', { className: 'asset-plain detail-body' });
      pre.appendChild(el('code', { textContent: content.text }));
      return pre;
    }
    case 'image':
      return watchMedia(el('img', { className: 'asset-media detail-body', src: content.url, alt: name, loading: 'lazy' }), 'image');
    case 'video':
      return watchMedia(el('video', { className: 'asset-media detail-body', src: content.url, controls: '' }), 'video');
    case 'audio':
      return watchMedia(el('audio', { className: 'asset-media asset-audio detail-body', src: content.url, controls: '' }), 'audio');
    case 'pdf':
      return watchMedia(el('iframe', { className: 'asset-media asset-pdf detail-body', src: content.url, title: name }), 'PDF');
    case 'webpage': {
      const frame = webpageFrame(name, path);
      frame.classList.add('detail-body');
      if ('url' in content) frame.src = content.url;
      else frame.srcdoc = content.text;
      opts.onWebpageReady?.(frame);
      return frame;
    }
    case 'binary': {
      const wrap = el('div', { className: 'asset-binary detail-body' });
      wrap.appendChild(el('p', { textContent: 'This file can’t be previewed.' }));
      if (content.url) {
        wrap.appendChild(el('a', {
          className: 'asset-download', href: content.url, download: path.split('/').pop() ?? name, target: '_blank', rel: 'noopener',
          textContent: 'Download file',
        }));
      }
      return wrap;
    }
  }
}

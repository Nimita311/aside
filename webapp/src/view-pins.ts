import type { WebappSidebarItem, WebappSidebarSection } from '../../cli/src/core/types';
import { artifactHandle, assertArtifactId, assertAttachmentFilename, parseArtifactHandle } from '../../cli/src/core/artifact-reference';
import { buildRoute, parseRoute, type ViewState } from './route';
import { parseEntityHandle } from './entity-reference';
import { dateHandle, parseDateHandle } from './date-reference';
import { canonicalEntrySource } from './entry-source-reference';

// Native URLs capture composed state without copying authorization/preview data.
function nativeView(target: string, instance: string): ViewState | undefined {
  if (!target.startsWith('aside://')) return undefined;
  const prefix = `aside://${instance}/`;
  if (!target.startsWith(prefix)) throw new Error('This sidebar target belongs to another instance.');
  const route = target.slice(prefix.length);
  const view = parseRoute(route);
  if (buildRoute(view) !== route) throw new Error('Invalid native sidebar target.');
  return view;
}

// Share the smart-element parsers used by content; rendering has no whitelist.
export function sidebarView(item: WebappSidebarItem, instance: string): ViewState {
  const target = (item.timeline ?? item.entity)!;
  const native = nativeView(target, instance);
  if (native) {
    if (item.timeline !== undefined && native.doc) throw new Error('A timeline target must open a flow.');
    if (item.entity !== undefined && !native.doc && native.filter?.type !== 'entry') throw new Error('An entity target must open content.');
    return native;
  }
  const empty: ViewState = { filter: null, doc: null };
  const entity = parseEntityHandle(target);
  if (entity) return { ...empty, filter: entity,
    doc: item.entity !== undefined && entity.type !== 'entry' ? { kind: 'detail' } : null,
    ...(item.timeline !== undefined && entity.type === 'entry' ? { filter: null, jump: entity.id } : {}) };
  const date = parseDateHandle(target);
  if (date && item.timeline !== undefined) return date.end
    ? { ...empty, range: { start: date.start, end: date.end } } : { ...empty, date };
  if (target.startsWith('#artifact/')) {
    if (item.timeline !== undefined) return { ...empty, source: canonicalEntrySource(target) };
    const ref = parseArtifactHandle(target)!;
    assertArtifactId(ref.id);
    if (ref.filename !== undefined) assertAttachmentFilename(ref.filename);
    return { ...empty, doc: { kind: 'artifact', ...ref } };
  }
  if (item.entity !== undefined || target.startsWith('#')) throw new Error('Unsupported sidebar handle.');
  return { ...empty, search: target };
}

export function viewPin(instance: string, view: ViewState, label: string): WebappSidebarItem {
  const route = buildRoute(view);
  const focusHandle = view.filter && `#${view.filter.type}/${view.filter.id}`;
  const nativeFocus = focusHandle && parseEntityHandle(focusHandle) ? focusHandle : undefined;
  if (view.doc) {
    const entity = view.doc.kind === 'artifact' ? artifactHandle(view.doc.id, view.doc.filename)
      : view.doc.kind === 'detail' && nativeFocus ? nativeFocus
      : `aside://${instance}/${buildRoute({ filter: view.doc.kind === 'detail' ? view.filter : null, doc: view.doc })}`;
    return { label, entity };
  }
  if (view.filter?.type === 'entry') return { label, entity: `#entry/${view.filter.id}` };
  const layers = [view.source, view.filter, view.search, view.range, view.order].filter(Boolean).length;
  const timeline = layers > 1 || view.order || view.jump || view.filter && !nativeFocus || view.search?.startsWith('#') || view.search?.startsWith('aside://') ? `aside://${instance}/${route}`
    : view.source ?? nativeFocus
    ?? (view.range ? dateHandle(view.range) : undefined) ?? (view.search || undefined)
    ?? (view.date ? dateHandle(view.date) : `aside://${instance}/`);
  return { label, timeline };
}

export function pinMatches(item: WebappSidebarItem, instance: string, view: ViewState): boolean {
  try {
    const expected = sidebarView(item, instance);
    if (item.entity === undefined) return buildRoute(expected) === buildRoute(view);
    const scoped = expected.doc?.kind === 'detail' || expected.filter?.type === 'entry';
    return buildRoute({ filter: scoped ? expected.filter : null, doc: expected.doc })
      === buildRoute({ filter: scoped ? view.filter : null, doc: view.doc });
  }
  catch { return false; }
}

// Pure list transformation. The browser and agent persist the same declaration.
export function toggleViewPin(sections: readonly WebappSidebarSection[], instance: string, view: ViewState, label: string): WebappSidebarSection[] {
  const exists = sections.some(section => section.items.some(item => pinMatches(item, instance, view)));
  return setViewPinned(sections, instance, view, label, !exists);
}

export function setViewPinned(sections: readonly WebappSidebarSection[], instance: string, view: ViewState, label: string, pinned: boolean): WebappSidebarSection[] {
  const next = sections.map(section => ({ ...section, items: section.items.filter(item => pinned || !pinMatches(item, instance, view)) }));
  if (!pinned) return next.filter(section => section.items.length || section.title);
  if (next.some(section => section.items.some(item => pinMatches(item, instance, view)))) return next;
  let section = next.find(section => !section.title);
  if (!section) { section = { items: [] }; next.push(section); }
  section.items.push(viewPin(instance, view, label));
  return next;
}

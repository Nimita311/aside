import type { WebappConfig, WebappSidebarItem, WebappSidebarSection } from './types.js';

export class SidebarConflictError extends Error {
  constructor(message = 'Pinned content changed elsewhere. Refresh and try again.') {
    super(message); this.name = 'SidebarConflictError';
  }
}

// Browser pinning changes one intention against an observed declaration. Agent
// replacements use their existing API and intentionally do not use this guard.
export function assertSidebarUnchanged(current: unknown, expected: unknown): void {
  const prior = assertWebappSidebar(expected);
  let actual: WebappSidebarSection[];
  try { actual = assertWebappSidebar(current); }
  catch { throw new SidebarConflictError('The current sidebar declaration is invalid. Ask the agent to repair it before pinning content.'); }
  if (JSON.stringify(actual) !== JSON.stringify(prior)) throw new SidebarConflictError();
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function object(value: unknown, path: string, fields: readonly string[]): Record<string, unknown> {
  if (!record(value)) throw new Error(`${path} must be an object.`);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`${path}.${key} is not a supported field.`);
  return value;
}
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${path} must be nonblank text.`);
  return value;
}

// Targets are authored smart elements or canonical Aside URLs. This boundary
// validates the declaration's shape without restricting future target syntax.
export function assertWebappSidebar(value: unknown): WebappSidebarSection[] {
  if (!Array.isArray(value)) throw new Error('webapp.sidebar must be an ordered array of sections.');
  return value.map((rawSection, sectionIndex) => {
    const path = `webapp.sidebar[${sectionIndex}]`;
    const section = object(rawSection, path, ['title', 'items']);
    if (!Array.isArray(section.items)) throw new Error(`${path}.items must be an ordered array.`);
    const items = section.items.map((rawItem, itemIndex): WebappSidebarItem => {
      const itemPath = `${path}.items[${itemIndex}]`;
      const item = object(rawItem, itemPath, ['label', 'timeline', 'entity']);
      const timeline = Object.hasOwn(item, 'timeline'), entity = Object.hasOwn(item, 'entity');
      if (timeline === entity) throw new Error(`${itemPath} must contain exactly one of timeline or entity.`);
      const label = item.label === undefined ? {} : { label: text(item.label, `${itemPath}.label`) };
      return timeline ? { ...label, timeline: text(item.timeline, `${itemPath}.timeline`) }
        : { ...label, entity: text(item.entity, `${itemPath}.entity`) };
    });
    return { ...(section.title === undefined ? {} : { title: text(section.title, `${path}.title`) }), items };
  });
}

export function assertWebappSettings(value: unknown): WebappConfig {
  const settings = object(value, 'webapp', ['sidebar']);
  return settings.sidebar === undefined ? {} : { sidebar: assertWebappSidebar(settings.sidebar) };
}

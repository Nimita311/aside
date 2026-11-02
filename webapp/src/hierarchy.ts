// The related_projects graph shaped as trees. Links are directional —
// declared on the higher-level project — so a forward link reads "child" and
// a reverse link "parent". One shape centers on a single project (every
// ancestor path down to it, then its full descendant subtree); the other is
// the whole instance's forest.

// One direction of a related_projects link, as the store's relation map
// carries it (a subset of its relatedProjects entry shape).
export interface RelatedProjectLink {
  id: string;
  description?: string;
  reverse?: boolean;
}

export interface HierarchyNode {
  id: string;
  // The declared description of the link to the parent row above; roots and
  // the description-less have none.
  description?: string;
  children: HierarchyNode[];
}

// Build the hierarchy for `id` from the relation map (both link directions per
// project). Returns the root nodes — [] when the project has no links. The
// graph may not be a tree: a project reached twice (several parents, or a
// cycle) expands its children only the first time and repeats as a leaf.
export function buildProjectHierarchy(
  id: string,
  related: Map<string, RelatedProjectLink[]>,
): HierarchyNode[] {
  const linksOf = (p: string) => related.get(p) ?? [];
  const parentsOf = (p: string) => linksOf(p).filter((l) => l.reverse).map((l) => l.id);
  const childrenOf = (p: string) => linksOf(p).filter((l) => !l.reverse);

  // Every ancestor, walked upward breadth-first (cycle-safe).
  const ancestors = new Set<string>();
  const queue = parentsOf(id);
  while (queue.length) {
    const p = queue.shift()!;
    if (p === id || ancestors.has(p)) continue;
    ancestors.add(p);
    queue.push(...parentsOf(p));
  }

  // Roots: ancestors with no parents of their own, or the project itself when
  // nothing links here.
  const roots = ancestors.size === 0
    ? (childrenOf(id).length ? [id] : [])
    : [...ancestors].filter((p) => parentsOf(p).length === 0);

  // Above the project only ancestor paths render — each ancestor's children
  // filtered to the ancestry and the project; from the project down the whole
  // subtree renders. `expanded` is the once-only guard (dedupe and cycles).
  const expanded = new Set<string>();
  const build = (p: string, description: string | undefined, below: boolean): HierarchyNode => {
    const node: HierarchyNode = { id: p, description, children: [] };
    if (expanded.has(p)) return node;
    expanded.add(p);
    const all = below || p === id;
    const links = all ? childrenOf(p) : childrenOf(p).filter((l) => ancestors.has(l.id) || l.id === id);
    node.children = links.map((l) => build(l.id, l.description, all));
    return node;
  };

  const nodes = roots.map((r) => build(r, undefined, false));
  // A cyclic ancestor cluster has no parentless member, so nothing above
  // reaches it — sweep unexpanded ancestors up as extra roots (in discovery
  // order: nearest first) until every ancestor path is on the tree.
  for (const p of ancestors) if (!expanded.has(p)) nodes.push(build(p, undefined, false));
  return nodes;
}

// The whole instance's hierarchy: every given project on one forest. Roots
// are the projects nothing links to (in the given order — the index's), each
// expanded through its forward links; root rows carry the description given
// with them (their index description), child rows the link's declared one.
// As everywhere, a project reached twice expands only the first time, and a
// cyclic cluster — no parentless member — is swept up as an extra root.
export function buildProjectForest(
  items: { id: string; description?: string }[],
  related: Map<string, RelatedProjectLink[]>,
): HierarchyNode[] {
  const linksOf = (p: string) => related.get(p) ?? [];
  const parentsOf = (p: string) => linksOf(p).filter((l) => l.reverse);
  const childrenOf = (p: string) => linksOf(p).filter((l) => !l.reverse);

  const expanded = new Set<string>();
  const build = (p: string, description: string | undefined): HierarchyNode => {
    const node: HierarchyNode = { id: p, description, children: [] };
    if (expanded.has(p)) return node;
    expanded.add(p);
    node.children = childrenOf(p).map((l) => build(l.id, l.description));
    return node;
  };

  const nodes = items.filter((it) => parentsOf(it.id).length === 0).map((it) => build(it.id, it.description));
  for (const it of items) if (!expanded.has(it.id)) nodes.push(build(it.id, it.description));
  return nodes;
}

import { describe, it, expect } from 'vitest';
import { buildProjectHierarchy, HierarchyNode, RelatedProjectLink } from '../src/hierarchy';

// A relation map from parent→child edges, both directions per project — the
// shape buildRelations gives relatedProjects.
function relations(edges: [parent: string, child: string, description?: string][]) {
  const map = new Map<string, RelatedProjectLink[]>();
  const push = (key: string, link: RelatedProjectLink) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(link);
  };
  for (const [parent, child, description] of edges) {
    push(parent, { id: child, description, reverse: false });
    push(child, { id: parent, description, reverse: true });
  }
  return map;
}

// The tree flattened to "indented id" lines, for readable shape assertions.
function shape(nodes: HierarchyNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${'  '.repeat(depth)}${n.id}`, ...shape(n.children, depth + 1)]);
}

describe('buildProjectHierarchy', () => {
  it('is empty for a project with no links', () => {
    expect(buildProjectHierarchy('lone', relations([['a', 'b']]))).toEqual([]);
  });

  it('roots at the project itself when nothing links here', () => {
    const rel = relations([['top', 'sub', 'part one'], ['sub', 'leaf'], ['top', 'other']]);
    expect(shape(buildProjectHierarchy('top', rel))).toEqual([
      'top', '  sub', '    leaf', '  other',
    ]);
  });

  it('shows the ancestor path down to the project, excluding unrelated siblings', () => {
    const rel = relations([['root', 'mid', 'the mid link'], ['root', 'other'], ['mid', 'me'], ['me', 'child']]);
    const tree = buildProjectHierarchy('me', rel);
    expect(shape(tree)).toEqual(['root', '  mid', '    me', '      child']);
    // Each row carries the description of the link to its parent row.
    expect(tree[0].description).toBeUndefined();
    expect(tree[0].children[0].description).toBe('the mid link');
  });

  it('expands a project reached twice only once (diamond)', () => {
    const rel = relations([['root', 'a'], ['root', 'b'], ['a', 'me'], ['b', 'me'], ['me', 'child']]);
    expect(shape(buildProjectHierarchy('me', rel))).toEqual([
      'root', '  a', '    me', '      child', '  b', '    me',
    ]);
  });

  it('terminates on a cycle, repeating the revisited project as a leaf', () => {
    const rel = relations([['a', 'b'], ['b', 'a'], ['b', 'me']]);
    // The all-cycle ancestry has no parentless root; the direct parent tops the tree.
    expect(shape(buildProjectHierarchy('me', rel))).toEqual([
      'b', '  a', '    b', '  me',
    ]);
  });

  it('shows a cyclic ancestor cluster even when another root exists', () => {
    const rel = relations([['root', 'me'], ['a', 'b'], ['b', 'a'], ['b', 'me']]);
    expect(shape(buildProjectHierarchy('me', rel))).toEqual([
      'root', '  me', 'b', '  a', '    b', '  me',
    ]);
  });
});

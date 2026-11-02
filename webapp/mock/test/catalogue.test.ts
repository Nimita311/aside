import { describe, expect, it } from 'vitest';
import { catalogue, filterCatalogue, type CatalogueNode } from '../gallery/catalogue';
import { scenarios } from '../scenarios';

function scenarioIds(nodes: readonly CatalogueNode[]): string[] {
  return nodes.flatMap(node => 'scenarioId' in node ? [node.scenarioId] : scenarioIds(node.children));
}

describe('page and state catalogue coverage', () => {
  it('places every registered scenario in the hierarchy exactly once', () => {
    expect(scenarioIds(catalogue).sort()).toEqual(scenarios.map(item => item.id).sort());
    const branchIds: string[] = [];
    const visit = (nodes: readonly CatalogueNode[]) => {
      for (const node of nodes) {
        expect(node.label.trim()).not.toBe('');
        if ('children' in node) {
          branchIds.push(node.id);
          expect(node.children.length, `${node.label} has page states`).toBeGreaterThan(0);
          visit(node.children);
        }
      }
    };
    visit(catalogue);
    expect(new Set(branchIds).size).toBe(branchIds.length);
  });

  it('keeps a matching page with all its states and keeps individual states discoverable', () => {
    expect(scenarioIds(filterCatalogue(catalogue, '', scenarios)).sort()).toEqual(scenarioIds(catalogue).sort());
    for (const page of catalogue) {
      const matchingPage = filterCatalogue(catalogue, page.label, scenarios)
        .find(node => 'children' in node && node.id === page.id);
      expect(matchingPage && 'children' in matchingPage ? scenarioIds(matchingPage.children) : undefined)
        .toEqual(scenarioIds(page.children));
    }
    for (const item of scenarios) {
      expect(scenarioIds(filterCatalogue(catalogue, item.id, scenarios)), `${item.id} is searchable`).toContain(item.id);
    }
  });
});

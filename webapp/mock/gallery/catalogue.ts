import type { Scenario } from '../scenarios';

export interface CatalogueBranch {
  id: string;
  label: string;
  children: CatalogueNode[];
}

export interface CatalogueLeaf {
  scenarioId: string;
  label: string;
}

export type CatalogueNode = CatalogueBranch | CatalogueLeaf;

const leaf = (scenarioId: string, label: string): CatalogueLeaf => ({ scenarioId, label });
const branch = (id: string, label: string, children: CatalogueNode[]): CatalogueBranch => ({ id, label, children });

/** Page navigation is explicit: each scenario belongs to one page and state. */
export const catalogue: CatalogueBranch[] = [
  branch('elements', 'Elements', [
    leaf('elements', 'All elements'),
  ]),
  branch('instances', 'Instances', [
    leaf('chooser', 'All instances'),
    leaf('chooser-empty', 'Empty'),
    leaf('chooser-loading', 'Loading'),
    leaf('chooser-error', 'Unavailable'),
    leaf('chooser-worktrees', 'Worktree family'),
    leaf('chooser-duplicates', 'Duplicate IDs'),
    leaf('chooser-tooltip', 'Status tooltip'),
    leaf('operation-error', 'Action failed'),
    branch('add-instance', 'Add instance', [
      leaf('chooser-add', 'Form'),
      leaf('chooser-invalid', 'Validation error'),
    ]),
  ]),
  branch('timeline', 'Timeline', [
    leaf('timeline', 'Default'),
    leaf('empty-instance', 'New instance'),
    leaf('instance-loading', 'Loading'),
    leaf('instance-error', 'Unavailable'),
    leaf('diagnostics', 'File diagnostics'),
    leaf('reconnecting', 'Reconnecting'),
    branch('timeline-navigation', 'Navigation', [
      leaf('entry-jump', 'Jump to entry'),
      leaf('date-jump', 'Jump to day'),
      leaf('date-range', 'Date range'),
    ]),
    branch('timeline-display', 'Display', [
      leaf('expanded-tags', 'Expanded references'),
      leaf('reference-hover', 'Reference hover'),
      leaf('dates-long', 'Long dates and times'),
      leaf('dates-iso', 'ISO dates'),
      leaf('motion', 'Motion'),
    ]),
  ]),
  branch('instance-details', 'Instance details', [
    leaf('instance-summary', 'Summary'),
    leaf('instance-detail', 'Full detail'),
    leaf('status-marks', 'Action lifecycle'),
  ]),
  branch('project', 'Project', [
    leaf('project', 'Timeline'),
    leaf('project-detail', 'Full detail'),
    leaf('empty-project', 'No entries'),
    leaf('project-date', 'Date jump'),
    branch('project-panel', 'Details panel', [
      leaf('panel-retracted', 'Retracted'),
      leaf('panel-wide', 'Wide'),
    ]),
  ]),
  branch('action', 'Action', [
    leaf('action', 'Timeline'),
    leaf('action-detail', 'Full detail'),
    leaf('empty-action', 'No entries'),
    leaf('recurring-action', 'Recurring'),
  ]),
  branch('entry', 'Entry', [
    leaf('entry-detail', 'Detail'),
  ]),
  branch('reader', 'Reader', [
    branch('reader-typography', 'Typography', [
      leaf('typography', 'Specimen'),
      leaf('typography-in-project', 'Within a project'),
    ]),
    branch('reader-diagrams', 'Diagrams', [
      leaf('diagrams', 'Rendered'),
      leaf('diagram-source', 'Source open'),
      leaf('diagram-error', 'Render failure'),
    ]),
    branch('reader-media', 'Media and attachments', [
      leaf('media', 'Collection'),
      leaf('image', 'Image'),
      leaf('pdf', 'PDF'),
      leaf('audio', 'Audio'),
      leaf('video', 'Video'),
      leaf('markdown-attachment', 'Markdown'),
      leaf('plain-text', 'Plain text'),
      leaf('binary', 'Binary download'),
      leaf('inline-webpage', 'Inline webpage'),
      leaf('missing-file', 'Missing attachment'),
      leaf('file-error', 'Read failure'),
    ]),
    leaf('dashboard', 'Interactive dashboard'),
    leaf('raw-asset', 'Raw file'),
    leaf('empty-artifact', 'Blank artifact'),
  ]),
  branch('search', 'Search', [
    leaf('search', 'Results'),
    leaf('search-empty', 'No matches'),
    leaf('search-date', 'Dates'),
    leaf('search-loading', 'Loading history'),
    leaf('search-incomplete', 'Incomplete history'),
  ]),
  branch('date-picker', 'Date picker', [
    leaf('datepicker', 'Calendar'),
    leaf('datepicker-invalid', 'Validation error'),
  ]),
  branch('settings', 'Settings', [
    leaf('settings', 'Display preferences'),
    leaf('settings-calendar-warning', 'Calendar warning'),
  ]),
  branch('instance-switcher', 'Instance switcher', [
    leaf('switcher', 'Menu'),
    leaf('switcher-empty', 'No matches'),
  ]),
  branch('browser-access', 'Browser access', [
    leaf('auth-checking', 'Checking'),
    leaf('auth-required', 'Required'),
    leaf('auth-offline', 'Offline'),
  ]),
];

/** Retain the page hierarchy while searching state labels and fixture metadata. */
export function filterCatalogue(nodes: readonly CatalogueNode[], query: string, scenarios: readonly Scenario[]): CatalogueNode[] {
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
  const needle = normalize(query);
  const byId = new Map(scenarios.map(scenario => [scenario.id, scenario]));

  const filter = (items: readonly CatalogueNode[], parentMatches: boolean): CatalogueNode[] => {
    const matches: CatalogueNode[] = [];
    for (const node of items) {
      if ('children' in node) {
        const branchMatches = parentMatches || normalize(`${node.label} ${node.id} ${node.id.replace(/-/g, ' ')}`).includes(needle);
        const children = filter(node.children, branchMatches);
        if (children.length) matches.push({ ...node, children });
        continue;
      }
      const scenario = byId.get(node.scenarioId);
      if (!scenario) continue;
      const text = normalize([node.label, scenario.label, scenario.id, scenario.description, ...scenario.coverage].join(' '));
      if (parentMatches || text.includes(needle)) matches.push({ ...node });
    }
    return matches;
  };

  return filter(nodes, needle.length === 0);
}

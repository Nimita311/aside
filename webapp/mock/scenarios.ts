/** Dev-only catalogue. Each preview runs the shipped UI against an isolated session. */
export type MockFixture = 'showcase' | 'empty' | 'malformed';
export interface MockFaults {
  auth?: 'checking' | 'required' | 'offline';
  catalogue?: 'empty' | 'error' | 'loading' | 'duplicates' | 'worktrees' | 'warnings';
  instance?: 'error' | 'loading';
  connection?: 'offline' | 'reconnecting';
  files?: 'missing' | 'error';
  search?: 'loading' | 'incomplete';
  diagnostics?: boolean;
  operations?: 'error';
}
export interface MockAction {
  kind: 'click' | 'input' | 'hover' | 'focus' | 'wait' | 'key';
  selector: string;
  value?: string;
}
export interface Scenario {
  kind?: 'elements';
  id: string;
  label: string;
  group: string;
  description: string;
  route: string;
  fixture: MockFixture;
  now: string;
  coverage: string[];
  preferences?: Record<string, string>;
  actions?: MockAction[];
  ready?: string;
  faults?: MockFaults;
}

export const MOCK_NOW = '2026-10-18T10:00:00-07:00';
const project = '2026-10-12-aurora';
const action = '2026-10-12-review';
const artifact = (name: string, filename?: string) => `/showcase/artifact/2026-10-12-${name}${filename ? `/${filename}` : ''}`;
const decisionSource = '#artifact/2026-10-12-recent-decisions/decisions.json';
const sourceQuery = new URLSearchParams({ source: decisionSource }).toString();
const click = (selector: string): MockAction => ({ kind: 'click', selector });
const input = (selector: string, value: string): MockAction => ({ kind: 'input', selector, value });
const key = (selector: string, value: string): MockAction => ({ kind: 'key', selector, value });
const searchTrigger = '#workspace-frame[data-frame="expanded"] #btn-navigation-search:not(:disabled), #workspace-frame[data-frame="compact"] #btn-pill-search:not(:disabled)';
const moreTrigger = '#workspace-frame[data-frame="expanded"] #btn-navigation-more, #workspace-frame[data-frame="compact"] #btn-pill-more';
function scenario(id: string, label: string, group: string, description: string, route: string, coverage: string[], options: Partial<Omit<Scenario, 'id' | 'label' | 'group' | 'description' | 'route' | 'coverage'>> = {}): Scenario {
  return { id, label, group, description, route, coverage, fixture: 'showcase', now: MOCK_NOW, ready: '#flow .entry-card', ...options };
}

// Content previews exercise the expanded Content selection instead of
// waiting for document nodes concealed by summary or Overview.
function expandedContextScenario(...args: Parameters<typeof scenario>): Scenario {
  const result = scenario(...args);
  return { ...result, preferences: { ...result.preferences, contextPanelMode: 'expanded', contextPanelView: 'content' } };
}

export const scenarios: Scenario[] = [
  scenario('timeline', 'Timeline', 'Pages', 'A working launch journal with projects, actions, references and rich content.', '/showcase/', ['timeline', 'entry cards', 'date markers', 'references']),
  scenario('query-source', 'Recent decisions', 'Pages', 'An explicitly configured timeline attachment renders decisions and reviews in the ordinary entry timeline.', `/showcase/?${sourceQuery}`, ['agent entry source', 'grouped query', 'query pagination', 'source chip']),
  scenario('query-source-scoped', 'Decisions in a project', 'Pages', 'The named query, one project pill, and a literal search remain independent filters.', `/showcase/project/${project}?${sourceQuery}&search=calmer`, ['query intersection', 'project pill', 'literal search', 'independent filters']),
  scenario('query-source-inspection', 'Inspect an entry query', 'Navigation', 'Read the agent-owned query and its current browsing inputs without an editor.', `/showcase/?${sourceQuery}`, ['source inspection', 'read-only GraphQL', 'query settings'], { actions: [click(moreTrigger), click('#btn-inspect-view')], ready: '#workspace-inspection' }),
  scenario('query-source-unavailable', 'Unavailable entry view', 'States', 'A missing attachment stays an explicit recoverable error rather than broadening to all entries.', `/showcase/?${new URLSearchParams({ source: '#artifact/2026-10-12-unavailable/decisions.json' })}`, ['source unavailable', 'query recovery', 'no automatic broadening'], { ready: '#query-flow-notice' }),
  scenario('elements', 'Elements', 'Elements', 'Icons, status pills, references, controls and notices using the application’s own styles and renderers.', '/__mock/elements/', ['icons', 'pills', 'references', 'buttons', 'form controls', 'notices', 'typography'], { kind: 'elements', ready: '#element-gallery[data-ready]' }),
  scenario('instance-summary', 'Instance summary', 'Pages', 'The instance overview with open projects, action planning and linked content.', '/showcase/', ['instance summary', 'planning', 'related lists'], { ready: '#side-panel-body .instance-summary' }),
  expandedContextScenario('instance-detail', 'Instance detail', 'Pages', 'The complete instance record in the expanded context panel.', '/showcase/detail', ['instance detail', 'metadata', 'reader'], { ready: '#side-panel-body .instance-summary [data-context-detail] .detail-body' }),
  scenario('project', 'Project timeline', 'Pages', 'Aurora entries alongside its hierarchy, relationships and action schedule.', `/showcase/project/${project}`, ['project filter', 'project summary', 'hierarchy']),
  expandedContextScenario('project-detail', 'Project detail', 'Pages', 'The full project record with nested relationships and maintained documents.', `/showcase/project/${project}/detail`, ['project detail', 'front matter', 'reader'], { ready: '#side-panel-body .project-summary [data-context-detail] .detail-body' }),
  scenario('action', 'Action timeline', 'Pages', 'A scheduled review with context, linked projects and action status.', `/showcase/action/${action}`, ['action filter', 'action summary', 'scheduled action']),
  expandedContextScenario('action-detail', 'Action detail', 'Pages', 'Action metadata, schedule, deadline and supporting content.', `/showcase/action/${action}/detail`, ['action detail', 'front matter', 'reader'], { ready: '#side-panel-body .action-summary [data-context-detail] .detail-body' }),
  expandedContextScenario('entry-detail', 'Entry detail', 'Pages', 'One journal entry, its references, and its backlinks.', '/showcase/entry/2026-10-18T09:30', ['entry detail', 'references', 'backlinks'], { ready: '#side-panel-body .entry-detail' }),
  scenario('entry-jump', 'Jump to an entry', 'Navigation', 'An exact timestamp deep link restores the matching entry in the timeline.', '/showcase/2026-10-16T11:15', ['entry jump', 'deep link', 'highlight']),
  scenario('date-jump', 'Jump to a day', 'Navigation', 'A calendar route lands on the nearest entries for the requested date.', '/showcase/date/2026-10-15', ['date route', 'date jump']),
  scenario('date-range', 'Jump to a date range', 'Navigation', 'A week-sized date reference opens the relevant timeline history.', '/showcase/date/2026-10-12/2026-10-18', ['date range', 'history navigation']),
  scenario('project-date', 'Date within a project', 'Navigation', 'Calendar navigation preserves the active project filter.', `/showcase/project/${project}/date/2026-10-15`, ['project date route', 'filtered history']),
  scenario('panel-retracted', 'Automatic frame', 'Navigation', 'Navigation and context adapt to the available width, with the control pill taking over on compact screens.', `/showcase/project/${project}`, ['automatic panels', 'responsive layout', 'control pill']),
  scenario('panel-wide', 'Context summary', 'Navigation', 'The current project summary appears in the right overlay, with the same panel available through compact controls.', `/showcase/project/${project}`, ['context summary', 'responsive controls', 'wrapping'], { ready: '#side-panel-body .entity-view' }),
  scenario('expanded-tags', 'Expanded references', 'Navigation', 'Project and action chips display their full names across the timeline.', '/showcase/', ['expanded tags', 'long names'], { preferences: { expandProjects: 'true', expandActions: 'true' } }),
  scenario('reference-hover', 'Linked reference hover', 'Navigation', 'Hovering an Aurora reference highlights other mentions of the same project.', '/showcase/', ['reference co-hover', 'reference status'], { actions: [{ kind: 'hover', selector: `[data-ref-type="project"][data-ref-id="${project}"]` }], ready: '.is-cohovered' }),

  expandedContextScenario('typography', 'Typography specimen', 'Content', 'Headings, prose, emphasis, lists, quotes, tables, code and Unicode in the real Markdown renderer.', artifact('typography'), ['h1–h6', 'prose', 'lists', 'tables', 'quotes', 'code', 'Unicode'], { ready: '#side-panel-body .artifact-detail .detail-body' }),
  expandedContextScenario('typography-in-project', 'Typography with context', 'Content', 'The same specimen opens in expanded context above its filtered project timeline.', `/showcase/project/${project}/artifact/2026-10-12-typography`, ['artifact route composition', 'filtered reader'], { ready: '#side-panel-body .artifact-detail .detail-body' }),
  expandedContextScenario('diagrams', 'Mermaid diagrams', 'Content', 'A curated set of native Mermaid diagrams with source disclosure and theme-aware rendering.', artifact('diagrams'), ['Mermaid', 'flowchart', 'sequence', 'state', 'class', 'ER', 'Gantt', 'pie', 'mindmap', 'timeline'], { ready: '#side-panel-body .artifact-detail .detail-body' }),
  expandedContextScenario('diagram-source', 'Diagram source', 'Content', 'A rendered diagram keeps its original Mermaid source available in a disclosure.', artifact('diagrams'), ['diagram source', 'source disclosure'], { actions: [{ kind: 'wait', selector: '#side-panel-body .mermaid-diagram[data-diagram-state="ready"]' }, click('#side-panel-body .mermaid-source summary')], ready: '#side-panel-body .mermaid-source[open]' }),
  expandedContextScenario('diagram-error', 'Diagram recovery', 'States', 'An intentionally invalid Mermaid diagram keeps its source readable with an explicit retry control.', artifact('diagram-error'), ['diagram failure', 'readable source', 'retry diagram'], { ready: '#side-panel-body .mermaid-diagram[data-diagram-state="error"] .mermaid-retry' }),
  expandedContextScenario('empty-artifact', 'Blank artifact', 'States', 'A maintained artifact can have a stable identity before its content is written.', artifact('empty'), ['empty artifact', 'artifact identity'], { ready: '#side-panel-body .artifact-detail' }),
  expandedContextScenario('media', 'Media collection', 'Content', 'An attachment catalogue demonstrates the supported image, document, audio and video readers.', artifact('media'), ['artifact attachments', 'media references'], { ready: '#side-panel-body .artifact-detail' }),
  expandedContextScenario('image', 'Image attachment', 'Content', 'A scalable Aurora illustration with its parent artifact and backlinks.', artifact('media', 'aurora.svg'), ['image', 'SVG', 'attachment parent'], { ready: '#side-panel-body img.asset-media' }),
  expandedContextScenario('pdf', 'PDF attachment', 'Content', 'A local launch brief displayed in the PDF reader.', artifact('media', 'launch-brief.pdf'), ['PDF', 'document embed'], { ready: '#side-panel-body .asset-pdf' }),
  expandedContextScenario('audio', 'Audio attachment', 'Content', 'A short synthetic chime demonstrates native playback controls.', artifact('media', 'chime.wav'), ['audio', 'native controls'], { ready: '#side-panel-body audio' }),
  expandedContextScenario('video', 'Video attachment', 'Content', 'A short local orbit animation demonstrates video playback controls.', artifact('media', 'orbit.mp4'), ['video', 'native controls'], { ready: '#side-panel-body video' }),
  expandedContextScenario('markdown-attachment', 'Markdown attachment', 'Content', 'Supporting Markdown renders with the same type system as maintained content.', artifact('media', 'notes.md'), ['Markdown attachment', 'reader'], { ready: '#side-panel-body .artifact-detail .detail-body' }),
  expandedContextScenario('plain-text', 'Plain text attachment', 'Content', 'Structured JSON is shown verbatim, retaining indentation and punctuation.', artifact('media', 'manifest.json'), ['plain text', 'monospace', 'whitespace'], { ready: '#side-panel-body .asset-plain' }),
  expandedContextScenario('binary', 'Binary download', 'Content', 'A binary attachment provides an explicit download affordance.', artifact('media', 'archive.zip'), ['binary file', 'download'], { ready: '#side-panel-body .asset-download' }),
  expandedContextScenario('dashboard', 'Interactive dashboard', 'Content', 'A sandboxed artifact dashboard queries fixture data through the real iframe SDK.', artifact('dashboard'), ['HTML iframe', 'SDK queries', 'charts', 'filters'], { ready: '#side-panel-body .asset-webpage' }),
  expandedContextScenario('inline-webpage', 'Webpage within Markdown', 'Content', 'An authored iframe embeds the local dashboard inside a Markdown artifact using the app’s sandboxed webpage boundary.', artifact('media'), ['inline iframe', 'Markdown media', 'sandboxed webpage'], { ready: '#side-panel-body .detail-body .asset-webpage' }),
  expandedContextScenario('raw-asset', 'Raw file reader', 'Content', 'A root-relative file opens directly, including its linked entries.', '/showcase/asset/artifacts/2026/2026-10-12-media/notes.md', ['asset route', 'backlinks', 'Markdown file'], { ready: '#side-panel-body .asset-detail .detail-body' }),

  scenario('search', 'Search results', 'Overlays', 'Grouped matches across entries, projects, actions and artifacts.', '/showcase/', ['search groups', 'highlights', 'combobox'], { actions: [click(searchTrigger), input('.search-input', 'Aurora')], ready: '#search-results:not([hidden]) .search-result-group' }),
  scenario('search-empty', 'Search with no matches', 'Overlays', 'A complete search with no matches shows its empty result message.', '/showcase/', ['search empty state'], { actions: [click(searchTrigger), input('.search-input', 'zzzz-no-matching-record')], ready: '#search-results:not([hidden]) [role="status"]' }),
  scenario('search-date', 'Search dates', 'Overlays', 'Natural date search offers calendar navigation beside content results.', '/showcase/', ['date search', 'date formatting'], { actions: [click(searchTrigger), input('.search-input', 'October 15')], ready: '#search-results:not([hidden])' }),
  scenario('datepicker', 'Date picker', 'Overlays', 'The real date readout opens period navigation, date entry and a month calendar.', '/showcase/', ['date picker', 'calendar', 'period navigation'], { actions: [click('.date-latch-chip')], ready: '#date-jump' }),
  scenario('datepicker-invalid', 'Date validation', 'Overlays', 'An invalid date displays the calendar’s inline accessible error.', '/showcase/', ['date input', 'validation', 'inline error'], { actions: [click('.date-latch-chip'), input('.date-jump-input', 'not a date'), key('.date-jump-input', 'Enter')], ready: '#date-jump-error:not([hidden])' }),
  scenario('settings', 'Display settings', 'Overlays', 'Date styles, clock, animation and reference preferences in the settings dialog.', '/showcase/', ['settings dialog', 'select controls', 'time preview'], { actions: [click(moreTrigger), click('#btn-settings')], ready: '#modal-backdrop[open]' }),
  scenario('switcher', 'Instance switcher', 'Overlays', 'The compact instance menu supports search and keyboard navigation.', '/showcase/', ['instance menu', 'instance search'], { actions: [click('#btn-instance-switch')], ready: '#instance-switch-menu:not([hidden])' }),
  scenario('switcher-empty', 'Instance search with no matches', 'Overlays', 'A filtered switcher retains its search field and empty message.', '/showcase/', ['instance search empty state'], { actions: [click('#btn-instance-switch'), input('#instance-switch-search', 'no-such-instance')], ready: '.instance-menu-empty' }),
  scenario('settings-calendar-warning', 'Calendar status', 'Overlays', 'The settings dialog explains a fixture calendar warning with the instance path.', '/showcase/', ['calendar warning', 'instance status'], { faults: { catalogue: 'warnings' }, actions: [click(moreTrigger), click('#btn-settings')], ready: '#setting-instance-status:not([hidden])' }),

  scenario('chooser', 'Instance chooser', 'Instances', 'The full catalogue displays fictional instance descriptions and activity counts.', '/', ['instance cards', 'activity summary'], { ready: '#instance-list .instance-row' }),
  scenario('chooser-empty', 'No registered instances', 'Instances', 'An empty catalogue leaves the add-instance entry point available.', '/', ['empty catalogue', 'add instance'], { faults: { catalogue: 'empty' }, ready: '#instance-chooser:not([hidden]) #btn-add-instance:not([hidden])' }),
  scenario('chooser-add', 'Add instance form', 'Instances', 'The expanded registration form uses the real inputs, help and controls.', '/', ['registration form', 'folder picker'], { actions: [click('#btn-add-instance')], ready: '#instance-add-form:not([hidden])' }),
  scenario('chooser-invalid', 'Instance path validation', 'Instances', 'Submitting an empty registration form shows the app’s inline validation.', '/', ['registration validation', 'accessible errors'], { actions: [click('#btn-add-instance'), click('#instance-add-form button[type="submit"]')], ready: '#instance-add-path[aria-invalid="true"]' }),
  scenario('chooser-worktrees', 'Git worktree family', 'Instances', 'Primary and linked worktrees share an instance identity with distinct branches.', '/', ['worktree grouping', 'branch labels', 'calendar status'], { faults: { catalogue: 'worktrees' }, ready: '#instance-list .instance-row' }),
  scenario('chooser-duplicates', 'Duplicate instance IDs', 'Instances', 'Conflicting identities display paths and calendar warnings.', '/', ['duplicate ID', 'warning tooltip'], { faults: { catalogue: 'duplicates' }, ready: '#instance-list .instance-duplicate-error' }),
  scenario('chooser-tooltip', 'Instance status tooltip', 'Instances', 'Keyboard focus reveals the calendar status explanation on an instance card.', '/', ['tooltip', 'keyboard focus', 'calendar warning'], { faults: { catalogue: 'warnings' }, actions: [{ kind: 'focus', selector: '.instance-calendar-icon' }], ready: '#instance-tooltip:not([hidden])' }),
  scenario('chooser-loading', 'Loading the catalogue', 'States', 'A held catalogue request demonstrates the delayed loading notice.', '/', ['catalogue loading', 'delayed notice'], { faults: { catalogue: 'loading' }, ready: '#instance-notice .app-notice[data-kind="loading"]' }),
  scenario('chooser-error', 'Catalogue unavailable', 'States', 'A failed discovery request exposes the retry control.', '/', ['catalogue error', 'retry'], { faults: { catalogue: 'error' }, ready: '#btn-retry-instances:not([hidden])' }),
  scenario('operation-error', 'Operation failure toast', 'States', 'A failed catalogue action shows the real accessible failure toast while the instance remains available.', '/', ['operation failure', 'toast', 'accessible status'], { faults: { operations: 'error' }, actions: [click('#instance-list .instance-remove')], ready: '#action-toast' }),
  scenario('instance-loading', 'Loading an instance', 'States', 'The startup loading notice remains visible while its snapshot request is held.', '/showcase/', ['instance loading', 'startup notice'], { faults: { instance: 'loading' }, ready: '.instance-startup-notice .app-notice[data-kind="loading"]' }),
  scenario('instance-error', 'Instance unavailable', 'States', 'A failed instance load offers controls to retry or choose another instance.', '/showcase/', ['instance error', 'retry'], { faults: { instance: 'error' }, ready: '#flow .instance-recovery .notice-action' }),
  scenario('empty-instance', 'New instance onboarding', 'States', 'A verified empty instance offers a starter prompt and getting-started guide.', '/empty/', ['onboarding', 'starter prompt', 'empty instance'], { fixture: 'empty', ready: '.flow-empty[data-empty-kind="instance"]' }),
  scenario('empty-project', 'Project without entries', 'States', 'An existing project with no matching entries offers a clear-filter action.', '/showcase/project/2026-10-12-empty', ['empty project filter', 'clear filter'], { ready: '.flow-empty[data-empty-kind="filter"]' }),
  scenario('empty-action', 'Action without entries', 'States', 'An existing action can show its summary before any journal entries reference it.', '/showcase/action/2026-10-12-empty', ['empty action filter', 'action summary'], { ready: '.flow-empty[data-empty-kind="filter"]' }),
  scenario('diagnostics', 'Readable records with diagnostics', 'States', 'Valid records stay visible while the diagnostics banner identifies a malformed file.', '/malformed/', ['diagnostics', 'partial data', 'file issues'], { fixture: 'malformed', faults: { diagnostics: true }, actions: [click('#data-diagnostics-summary')], ready: '#data-diagnostics[open]' }),
  expandedContextScenario('missing-file', 'Missing attachment', 'States', 'A missing Markdown attachment renders its recoverable reader state.', artifact('media', 'notes.md'), ['missing file', 'reader recovery'], { faults: { files: 'missing' }, ready: '#side-panel-body .data-file-notice .history-retry' }),
  expandedContextScenario('file-error', 'Attachment read failure', 'States', 'An unavailable attachment demonstrates the reader’s error and retry controls.', artifact('media', 'notes.md'), ['file read error', 'reader recovery'], { faults: { files: 'error' }, ready: '#side-panel-body .data-file-notice .history-retry' }),
  scenario('search-loading', 'Loading search history', 'States', 'Search can show available matches while historical text is still loading.', '/showcase/', ['search indexing', 'progress'], { faults: { search: 'loading' }, actions: [click(searchTrigger), input('.search-input', 'Aurora')], ready: '.search-index-progress .app-notice' }),
  scenario('search-incomplete', 'Incomplete search history', 'States', 'A failed historical read leaves visible matches and a retry control.', '/showcase/', ['search incomplete', 'retry'], { faults: { search: 'incomplete' }, actions: [click(searchTrigger), input('.search-input', 'Aurora')], ready: '.search-index-progress .history-retry' }),
  scenario('auth-checking', 'Checking browser access', 'States', 'The access-check notice is visible before protected records load.', '/showcase/', ['authentication loading'], { faults: { auth: 'checking' }, ready: '#flow .app-notice[data-kind="loading"]' }),
  scenario('auth-required', 'Browser access required', 'States', 'An unauthenticated browser displays the actual reconnect guidance.', '/showcase/', ['authentication required', 'reconnect guidance'], { faults: { auth: 'required' }, ready: '#flow .app-notice[data-kind="warning"]' }),
  scenario('auth-offline', 'Daemon unavailable', 'States', 'A failed access check displays the offline connection guidance.', '/showcase/', ['authentication offline', 'connection error'], { faults: { auth: 'offline' }, ready: '#flow .app-notice[data-kind="error"]' }),
  scenario('reconnecting', 'Connection interrupted', 'States', 'Existing records remain readable while the control stream reconnects.', '/showcase/', ['SSE reconnecting', 'connection indicator'], { faults: { connection: 'reconnecting' }, ready: '#connection-status:not([hidden])' }),

  scenario('dates-long', 'Long date and time styles', 'Display', 'Expanded dates and times demonstrate consistent formatting across the app.', '/showcase/', ['long date', 'long time', '12-hour clock'], { preferences: { dateFormat: 'full', timeStyle: 'long', timeFormat: '12h' } }),
  scenario('dates-iso', 'ISO dates and 24-hour clock', 'Display', 'Compact numerical dates and a 24-hour clock in the timeline and detail panel.', '/showcase/', ['ISO date', '24-hour clock'], { preferences: { dateFormat: 'iso', timeStyle: 'short', timeFormat: '24h' } }),
  scenario('status-marks', 'Action lifecycle and deadlines', 'Display', 'Backlog, scheduled, overdue, completed, cancelled and recurring actions appear together.', '/showcase/', ['action statuses', 'deadline marks', 'recurrence', 'planning groups'], { ready: '#side-panel-body .instance-summary' }),
  expandedContextScenario('recurring-action', 'Recurring action', 'Display', 'A recurring standup demonstrates the template and projected occurrence presentation.', '/showcase/action/2026-10-12-standup/detail', ['recurrence template', 'schedule zone', 'action detail'], { ready: '#side-panel-body .action-summary [data-context-detail] .detail-body' }),
  scenario('motion', 'Application motion', 'Display', 'Normal animation remains enabled so navigation and panel transitions can be explored.', '/showcase/', ['animation', 'FLIP transitions', 'navigation'], { preferences: { animSpeed: '1' } }),
];

export function scenarioById(id: string): Scenario | undefined { return scenarios.find(item => item.id === id); }

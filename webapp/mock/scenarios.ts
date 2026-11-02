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
const click = (selector: string): MockAction => ({ kind: 'click', selector });
const input = (selector: string, value: string): MockAction => ({ kind: 'input', selector, value });
const key = (selector: string, value: string): MockAction => ({ kind: 'key', selector, value });
function scenario(id: string, label: string, group: string, description: string, route: string, coverage: string[], options: Partial<Omit<Scenario, 'id' | 'label' | 'group' | 'description' | 'route' | 'coverage'>> = {}): Scenario {
  return { id, label, group, description, route, coverage, fixture: 'showcase', now: MOCK_NOW, ready: '#flow .entry-card', ...options };
}

export const scenarios: Scenario[] = [
  scenario('timeline', 'Timeline', 'Pages', 'A working launch journal with projects, actions, references and rich content.', '/showcase/', ['timeline', 'entry cards', 'date markers', 'references']),
  scenario('elements', 'Elements', 'Elements', 'Icons, status pills, references, controls and notices using the application’s own styles and renderers.', '/__mock/elements/', ['icons', 'pills', 'references', 'buttons', 'form controls', 'notices', 'typography'], { kind: 'elements', ready: '#element-gallery[data-ready]' }),
  scenario('instance-summary', 'Instance summary', 'Pages', 'The instance overview with open projects, action planning and linked content.', '/showcase/', ['instance summary', 'planning', 'related lists'], { ready: '#side-panel-body .instance-summary' }),
  scenario('instance-detail', 'Instance detail', 'Pages', 'The complete instance record in the document reader.', '/showcase/detail', ['instance detail', 'metadata', 'reader'], { ready: '#doc-body .entity-detail' }),
  scenario('project', 'Project timeline', 'Pages', 'Aurora entries alongside its hierarchy, relationships and action schedule.', `/showcase/project/${project}`, ['project filter', 'project summary', 'hierarchy']),
  scenario('project-detail', 'Project detail', 'Pages', 'The full project record with nested relationships and maintained documents.', `/showcase/project/${project}/detail`, ['project detail', 'front matter', 'reader'], { ready: '#doc-body .entity-detail' }),
  scenario('action', 'Action timeline', 'Pages', 'A scheduled review with context, linked projects and action status.', `/showcase/action/${action}`, ['action filter', 'action summary', 'scheduled action']),
  scenario('action-detail', 'Action detail', 'Pages', 'Action metadata, schedule, deadline and supporting content.', `/showcase/action/${action}/detail`, ['action detail', 'front matter', 'reader'], { ready: '#doc-body .entity-detail' }),
  scenario('entry-detail', 'Entry detail', 'Pages', 'One journal entry, its references, and its backlinks.', '/showcase/entry/2026-10-18T09:30', ['entry detail', 'references', 'backlinks'], { ready: '#side-panel-body .entry-detail, #doc-body .entry-detail' }),
  scenario('entry-jump', 'Jump to an entry', 'Navigation', 'An exact timestamp deep link restores the matching entry in the timeline.', '/showcase/2026-10-16T11:15', ['entry jump', 'deep link', 'highlight']),
  scenario('date-jump', 'Jump to a day', 'Navigation', 'A calendar route lands on the nearest entries for the requested date.', '/showcase/date/2026-10-15', ['date route', 'date jump']),
  scenario('date-range', 'Jump to a date range', 'Navigation', 'A week-sized date reference opens the relevant timeline history.', '/showcase/date/2026-10-12/2026-10-18', ['date range', 'history navigation']),
  scenario('project-date', 'Date within a project', 'Navigation', 'Calendar navigation preserves the active project filter.', `/showcase/project/${project}/date/2026-10-15`, ['project date route', 'filtered history']),
  scenario('panel-retracted', 'Retracted panel', 'Navigation', 'The project panel retracts into the docked filter pill.', `/showcase/project/${project}`, ['filter pill', 'retracted panel'], { preferences: { panelCollapsed: 'true' }, ready: '#filter-pill:not([hidden])' }),
  scenario('panel-wide', 'Wide details panel', 'Navigation', 'A wider panel gives long titles and relationships room to breathe.', `/showcase/project/${project}`, ['panel resize', 'wrapping'], { preferences: { panelWidth: '440' }, ready: '#side-panel-body .entity-view' }),
  scenario('expanded-tags', 'Expanded references', 'Navigation', 'Project and action chips display their full names across the timeline.', '/showcase/', ['expanded tags', 'long names'], { preferences: { expandProjects: 'true', expandActions: 'true' } }),
  scenario('reference-hover', 'Linked reference hover', 'Navigation', 'Hovering an Aurora reference highlights other mentions of the same project.', '/showcase/', ['reference co-hover', 'reference status'], { actions: [{ kind: 'hover', selector: `[data-ref-type="project"][data-ref-id="${project}"]` }], ready: '.is-cohovered' }),

  scenario('typography', 'Typography specimen', 'Content', 'Headings, prose, emphasis, lists, quotes, tables, code and Unicode in the real Markdown renderer.', artifact('typography'), ['h1–h6', 'prose', 'lists', 'tables', 'quotes', 'code', 'Unicode'], { ready: '#doc-body .artifact-detail .detail-body' }),
  scenario('typography-in-project', 'Typography with context', 'Content', 'The same specimen opens above a filtered project timeline.', `/showcase/project/${project}/artifact/2026-10-12-typography`, ['artifact route composition', 'filtered reader'], { ready: '#doc-body .artifact-detail .detail-body' }),
  scenario('diagrams', 'Mermaid diagrams', 'Content', 'A curated set of native Mermaid diagrams with source disclosure and theme-aware rendering.', artifact('diagrams'), ['Mermaid', 'flowchart', 'sequence', 'state', 'class', 'ER', 'Gantt', 'pie', 'mindmap', 'timeline'], { ready: '#doc-body .artifact-detail .detail-body' }),
  scenario('diagram-source', 'Diagram source', 'Content', 'A rendered diagram keeps its original Mermaid source available in a disclosure.', artifact('diagrams'), ['diagram source', 'source disclosure'], { actions: [{ kind: 'wait', selector: '#doc-body .mermaid-diagram[data-diagram-state="ready"]' }, click('#doc-body .mermaid-source summary')], ready: '#doc-body .mermaid-source[open]' }),
  scenario('diagram-error', 'Diagram recovery', 'States', 'An intentionally invalid Mermaid diagram keeps its source readable with an explicit retry control.', artifact('diagram-error'), ['diagram failure', 'readable source', 'retry diagram'], { ready: '#doc-body .mermaid-diagram[data-diagram-state="error"] .mermaid-retry' }),
  scenario('empty-artifact', 'Blank artifact', 'States', 'A maintained artifact can have a stable identity before its content is written.', artifact('empty'), ['empty artifact', 'artifact identity'], { ready: '#doc-body .artifact-detail' }),
  scenario('media', 'Media collection', 'Content', 'An attachment catalogue demonstrates the supported image, document, audio and video readers.', artifact('media'), ['artifact attachments', 'media references'], { ready: '#doc-body .artifact-detail' }),
  scenario('image', 'Image attachment', 'Content', 'A scalable Aurora illustration with its parent artifact and backlinks.', artifact('media', 'aurora.svg'), ['image', 'SVG', 'attachment parent'], { ready: '#doc-body img.asset-media' }),
  scenario('pdf', 'PDF attachment', 'Content', 'A local launch brief displayed in the PDF reader.', artifact('media', 'launch-brief.pdf'), ['PDF', 'document embed'], { ready: '#doc-body .asset-pdf' }),
  scenario('audio', 'Audio attachment', 'Content', 'A short synthetic chime demonstrates native playback controls.', artifact('media', 'chime.wav'), ['audio', 'native controls'], { ready: '#doc-body audio' }),
  scenario('video', 'Video attachment', 'Content', 'A short local orbit animation demonstrates video playback controls.', artifact('media', 'orbit.mp4'), ['video', 'native controls'], { ready: '#doc-body video' }),
  scenario('markdown-attachment', 'Markdown attachment', 'Content', 'Supporting Markdown renders with the same type system as maintained content.', artifact('media', 'notes.md'), ['Markdown attachment', 'reader'], { ready: '#doc-body .artifact-detail .detail-body' }),
  scenario('plain-text', 'Plain text attachment', 'Content', 'Structured JSON is shown verbatim, retaining indentation and punctuation.', artifact('media', 'manifest.json'), ['plain text', 'monospace', 'whitespace'], { ready: '#doc-body .asset-plain' }),
  scenario('binary', 'Binary download', 'Content', 'A binary attachment provides an explicit download affordance.', artifact('media', 'archive.zip'), ['binary file', 'download'], { ready: '#doc-body .asset-download' }),
  scenario('dashboard', 'Interactive dashboard', 'Content', 'A sandboxed artifact dashboard queries fixture data through the real iframe SDK.', artifact('dashboard'), ['HTML iframe', 'SDK queries', 'charts', 'filters'], { ready: '#doc-body .asset-webpage' }),
  scenario('inline-webpage', 'Webpage within Markdown', 'Content', 'An authored iframe embeds the local dashboard inside a Markdown artifact using the app’s sandboxed webpage boundary.', artifact('media'), ['inline iframe', 'Markdown media', 'sandboxed webpage'], { ready: '#doc-body .detail-body .asset-webpage' }),
  scenario('raw-asset', 'Raw file reader', 'Content', 'A root-relative file opens directly, including its linked entries.', '/showcase/asset/artifacts/2026/2026-10-12-media/notes.md', ['asset route', 'backlinks', 'Markdown file'], { ready: '#doc-body .asset-detail .detail-body' }),

  scenario('search', 'Search results', 'Overlays', 'Grouped matches across entries, projects, actions and artifacts.', '/showcase/', ['search groups', 'highlights', 'combobox'], { actions: [input('.search-input', 'Aurora')], ready: '#search-results:not([hidden]) .search-result-group' }),
  scenario('search-empty', 'Search with no matches', 'Overlays', 'A complete search with no matches shows its empty result message.', '/showcase/', ['search empty state'], { actions: [input('.search-input', 'zzzz-no-matching-record')], ready: '#search-results:not([hidden]) [role="status"]' }),
  scenario('search-date', 'Search dates', 'Overlays', 'Natural date search offers calendar navigation beside content results.', '/showcase/', ['date search', 'date formatting'], { actions: [input('.search-input', 'October 15')], ready: '#search-results:not([hidden])' }),
  scenario('datepicker', 'Date picker', 'Overlays', 'The real date readout opens period navigation, date entry and a month calendar.', '/showcase/', ['date picker', 'calendar', 'period navigation'], { actions: [click('.date-latch-chip')], ready: '#date-jump' }),
  scenario('datepicker-invalid', 'Date validation', 'Overlays', 'An invalid date displays the calendar’s inline accessible error.', '/showcase/', ['date input', 'validation', 'inline error'], { actions: [click('.date-latch-chip'), input('.date-jump-input', 'not a date'), key('.date-jump-input', 'Enter')], ready: '#date-jump-error:not([hidden])' }),
  scenario('settings', 'Display settings', 'Overlays', 'Date styles, clock, animation and reference preferences in the settings dialog.', '/showcase/', ['settings dialog', 'select controls', 'time preview'], { actions: [click('#btn-settings')], ready: '#modal-backdrop[open]' }),
  scenario('switcher', 'Instance switcher', 'Overlays', 'The compact instance menu supports search and keyboard navigation.', '/showcase/', ['instance menu', 'instance search'], { actions: [click('#btn-instance-switch')], ready: '#instance-switch-menu:not([hidden])' }),
  scenario('switcher-empty', 'Instance search with no matches', 'Overlays', 'A filtered switcher retains its search field and empty message.', '/showcase/', ['instance search empty state'], { actions: [click('#btn-instance-switch'), input('#instance-switch-search', 'no-such-instance')], ready: '.instance-menu-empty' }),
  scenario('settings-calendar-warning', 'Calendar status', 'Overlays', 'The settings dialog explains a fixture calendar warning with the instance path.', '/showcase/', ['calendar warning', 'instance status'], { faults: { catalogue: 'warnings' }, actions: [click('#btn-settings')], ready: '#setting-instance-status:not([hidden])' }),

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
  scenario('missing-file', 'Missing attachment', 'States', 'A missing Markdown attachment renders its recoverable reader state.', artifact('media', 'notes.md'), ['missing file', 'reader recovery'], { faults: { files: 'missing' }, ready: '#doc-body .data-file-notice .history-retry' }),
  scenario('file-error', 'Attachment read failure', 'States', 'An unavailable attachment demonstrates the reader’s error and retry controls.', artifact('media', 'notes.md'), ['file read error', 'reader recovery'], { faults: { files: 'error' }, ready: '#doc-body .data-file-notice .history-retry' }),
  scenario('search-loading', 'Loading search history', 'States', 'Search can show available matches while historical text is still loading.', '/showcase/', ['search indexing', 'progress'], { faults: { search: 'loading' }, actions: [input('.search-input', 'Aurora')], ready: '.search-index-progress .app-notice' }),
  scenario('search-incomplete', 'Incomplete search history', 'States', 'A failed historical read leaves visible matches and a retry control.', '/showcase/', ['search incomplete', 'retry'], { faults: { search: 'incomplete' }, actions: [input('.search-input', 'Aurora')], ready: '.search-index-progress .history-retry' }),
  scenario('auth-checking', 'Checking browser access', 'States', 'The access-check notice is visible before protected records load.', '/showcase/', ['authentication loading'], { faults: { auth: 'checking' }, ready: '#flow .app-notice[data-kind="loading"]' }),
  scenario('auth-required', 'Browser access required', 'States', 'An unauthenticated browser displays the actual reconnect guidance.', '/showcase/', ['authentication required', 'reconnect guidance'], { faults: { auth: 'required' }, ready: '#flow .app-notice[data-kind="warning"]' }),
  scenario('auth-offline', 'Daemon unavailable', 'States', 'A failed access check displays the offline connection guidance.', '/showcase/', ['authentication offline', 'connection error'], { faults: { auth: 'offline' }, ready: '#flow .app-notice[data-kind="error"]' }),
  scenario('reconnecting', 'Connection interrupted', 'States', 'Existing records remain readable while the control stream reconnects.', '/showcase/', ['SSE reconnecting', 'connection indicator'], { faults: { connection: 'reconnecting' }, ready: '#connection-status:not([hidden])' }),

  scenario('dates-long', 'Long date and time styles', 'Display', 'Expanded dates and times demonstrate consistent formatting across the app.', '/showcase/', ['long date', 'long time', '12-hour clock'], { preferences: { dateFormat: 'full', timeStyle: 'long', timeFormat: '12h' } }),
  scenario('dates-iso', 'ISO dates and 24-hour clock', 'Display', 'Compact numerical dates and a 24-hour clock in the timeline and detail panel.', '/showcase/', ['ISO date', '24-hour clock'], { preferences: { dateFormat: 'iso', timeStyle: 'short', timeFormat: '24h' } }),
  scenario('status-marks', 'Action lifecycle and deadlines', 'Display', 'Backlog, scheduled, overdue, completed, cancelled and recurring actions appear together.', '/showcase/', ['action statuses', 'deadline marks', 'recurrence', 'planning groups'], { ready: '#side-panel-body .instance-summary' }),
  scenario('recurring-action', 'Recurring action', 'Display', 'A recurring standup demonstrates the template and projected occurrence presentation.', '/showcase/action/2026-10-12-standup/detail', ['recurrence template', 'schedule zone', 'action detail'], { ready: '#doc-body .entity-detail' }),
  scenario('motion', 'Application motion', 'Display', 'Normal animation remains enabled so navigation and panel transitions can be explored.', '/showcase/', ['animation', 'FLIP transitions', 'navigation'], { preferences: { animSpeed: '1' } }),
];

export function scenarioById(id: string): Scenario | undefined { return scenarios.find(item => item.id === id); }

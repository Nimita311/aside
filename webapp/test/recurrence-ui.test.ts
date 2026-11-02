// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import type { StoreView, PendingUpdate, HotSet, DataSnapshot } from '../../cli/src/core/data-snapshot';
import type { EntityRef } from '../lib/types';
import { RemoteStore, type SnapshotSource } from '../lib/remote-store';
import { loadApp } from './app-harness';
import { snapshotFixture } from './snapshot-fixture';

interface App {
  state: { store: StoreView | null; instanceId: string | null; filter: EntityRef | null; doc: { kind: 'detail' } | null; panelCollapsed: boolean };
  showSidePanel(): Promise<void>;
  refreshTimeDisplay(): void;
  refreshPlanningWindow(): Promise<void>;
  currentHotSet(): HotSet;
  applyDataUpdate(update: PendingUpdate): Promise<void>;
  updateDoc(): Promise<void>;
}
const template = '2026-01-01-repeat', path = `actions/2026/${template}.md`;
async function setup() {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-09T12:00:00Z'));
  document.body.innerHTML = '<div id="flow-scroll"><div id="flow"></div></div><aside id="side-panel"><div id="side-panel-body"></div></aside><dialog id="doc-backdrop"><div id="doc-body"></div></dialog>';
  let data = snapshotFixture(), version = 1;
  data.weeks = []; data.weeklyDates = []; data.indexes.notes = [];
  data.actions = [[template, { frontMatter: { name: 'Review', created: '2026-01-01T09:00', recurrence: [{ dtstart: '2026-01-01', rrule: 'FREQ=DAILY' }] }, body: 'Template instructions' }]];
  data.indexes.actions = [{ id: template, description: 'Review' }];
  const source: SnapshotSource = { snapshot: async prior => prior === String(version) ? 'unchanged' : { value: structuredClone(data), version: String(version) }, read: vi.fn(), revalidate: vi.fn(), assetUrl: () => null };
  const store = new RemoteStore(source); await store.init();
  const api = await loadApp<App>('state, showSidePanel, refreshTimeDisplay, refreshPlanningWindow, currentHotSet, applyDataUpdate, updateDoc');
  api.state.store = store; api.state.instanceId = 'work'; api.state.filter = null; api.state.doc = null; api.state.panelCollapsed = false;
  return { api, store, change: (edit: (snapshot: DataSnapshot) => void) => { edit(data); version++; } };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear(); });

it('updates the rolling projection window without file edits and retains loaded history pages', async () => {
  const { api } = await setup(); await api.showSidePanel();
  const panel = document.getElementById('side-panel-body')!;
  const pageButton = () => [...panel.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Load more recurrence history')!;
  panel.querySelector<HTMLButtonElement>('button[data-dir="past"]')!.click();
  pageButton().click(); await vi.waitFor(() => expect(panel.querySelectorAll('a[data-ref-type="action"]')).toHaveLength(200));
  const oldHistory = panel.querySelector<HTMLAnchorElement>('a[data-ref-id*="2026-05-01"]')!;
  expect(oldHistory).not.toBeNull();
  api.refreshTimeDisplay(); await api.refreshPlanningWindow();
  expect(oldHistory.isConnected).toBe(true); // unchanged window retains its controls
  vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
  api.refreshTimeDisplay(); await api.refreshPlanningWindow();
  expect(panel.querySelectorAll('a[data-ref-type="action"]')).toHaveLength(200);
  expect(panel.querySelector('a[data-ref-id*="2026-10-17"]')).not.toBeNull();
  expect(panel.querySelector('a[data-ref-id*="2026-05-01"]')).not.toBeNull();
});

it('tracks the template as a projected reader dependency and displays its diagnostics', async () => {
  const { api, store, change } = await setup();
  const projection = (await store.getPlanningActions()).nodes[0].id;
  api.state.filter = { type: 'action', id: projection }; api.state.doc = { kind: 'detail' };
  await api.updateDoc();
  expect(api.currentHotSet().entities).toContainEqual({ kind: 'action', id: template });
  change(data => {
    data.actions[0][1].body = 'Updated template instructions';
    data.diagnostics = [{ path, issues: [{ severity: 'warning', code: 'template_warning', message: 'Repair this template', file: path }] }];
  });
  const update = await store.check('light', api.currentHotSet()); await api.applyDataUpdate(update!);
  const reader = document.getElementById('doc-body')!;
  expect(reader.textContent).toContain('Updated template instructions');
  expect(reader.textContent).toContain('Repair this template');
  expect(reader.textContent).toContain(path);
});

it('keeps a malformed template readable with its parse diagnostic', async () => {
  const { api, store, change } = await setup();
  change(data => {
    (data.actions[0][1].frontMatter as unknown as Record<string, unknown>).recurrence = { rrule: 'FREQ=DAILY' };
    data.diagnostics = [{ path, issues: [{ severity: 'error', code: 'invalid_recurrence', message: 'recurrence must be a list', file: path }] }];
  });
  await store.reloadFile(path);
  api.state.filter = { type: 'action', id: template }; api.state.doc = { kind: 'detail' };
  await api.updateDoc();
  const reader = document.getElementById('doc-body')!;
  expect(reader.textContent).toContain('Template instructions');
  expect(reader.textContent).toContain('recurrence must be a list');
});

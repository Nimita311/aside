// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../lib/store';
import type { Entry, EntityRef } from '../lib/types';
import type { DocRef, ViewState } from '../src/route';
import type { createContextPanel } from '../src/context-panel';
import { loadApp } from './app-harness';

interface App {
  state: { store: Store | null; instanceId: string | null; filter: EntityRef | null; doc: DocRef | null };
  setupContextPanel(): void;
  jumpToEntry(id: string): Promise<void>;
  applyView(view: ViewState): Promise<void>;
  clearInstanceView(): void;
  handleLocationChange(event?: Event): Promise<void>;
  currentContext(): { ref: EntityRef | null; doc: DocRef | null };
  contextPanel?: ReturnType<typeof createContextPanel>;
}

function coldStore() {
  const pending: ((entries: Entry[]) => void)[] = [];
  const store = {
    getWeekEntries: () => new Promise<Entry[]>(resolve => pending.push(resolve)),
    getInstance: () => null,
    // The context panel reads an opened document through these.
    getAsset: async () => 'Later document',
    getRelations: async () => ({ entriesByAsset: new Map() }),
    getNoteIndex: () => [], diagnosticsFor: () => undefined,
  } as unknown as Store;
  const finish = (id: string, index = 0) => pending[index]([{ meta: { created: id }, weekFile: '2026-09-28', content: 'Earlier note' }]);
  return { store, finish };
}

let app: App | undefined;
afterEach(() => { app?.contextPanel?.destroy(); app = undefined; document.body.replaceChildren(); });

describe('superseded cold note jumps', () => {
  const earlier = '2026-10-04T10:00', newer = '2026-10-04T11:00';

  async function setup() {
    history.replaceState({}, '', '/work/');
    document.body.innerHTML = '<input id="kept-focus"><div id="flow"></div>' +
      '<aside id="side-panel"><button id="btn-context-expand">Expand</button><div id="side-panel-body"></div></aside>';
    const api = app = await loadApp<App>('state, setupContextPanel, jumpToEntry, applyView, clearInstanceView, handleLocationChange, currentContext, contextPanel'), cold = coldStore();
    api.state.store = cold.store;
    api.state.instanceId = 'work';
    api.setupContextPanel();
    await api.applyView({ filter: null, doc: null });
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.focus();
    return { api, ...cold, input };
  }

  it('keeps a newer document, URL, history entry and focus when an earlier lookup finishes', async () => {
    const { api, finish, input } = await setup();
    const jumping = api.jumpToEntry(earlier);
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/later.md' } });
    const historyLength = history.length;
    // Opening the document moves focus from the input into the panel.
    const panel = document.getElementById('side-panel-body')!, focused = document.activeElement;
    expect(focused).not.toBe(input);
    expect(panel.contains(focused)).toBe(true);
    finish(earlier);
    await jumping;
    expect(api.currentContext().doc).toEqual({ kind: 'asset', path: 'assets/later.md' });
    expect(api.contextPanel!.getState().open).toBe(true);
    expect(panel.textContent).toContain('Later document');
    expect(location.pathname).toBe('/work/asset/assets/later.md');
    expect(history.length).toBe(historyLength);
    expect(document.activeElement).toBe(focused);
  });

  it('does not clear a newer project filter', async () => {
    const { api, finish } = await setup();
    const jumping = api.jumpToEntry(earlier);
    const filter: EntityRef = { type: 'project', id: '2026-10-04-current' };
    await api.applyView({ filter, doc: null });
    finish(earlier);
    await jumping;
    expect(api.state.filter).toEqual(filter);
    expect(location.pathname).toBe('/work/project/2026-10-04-current');
  });

  it('cannot navigate the replacement instance with an old Store result', async () => {
    const { api, finish } = await setup();
    const jumping = api.jumpToEntry(earlier);
    api.clearInstanceView();
    api.state.store = coldStore().store;
    api.state.instanceId = 'home';
    history.pushState({}, '', '/home/');
    finish(earlier);
    await jumping;
    expect(api.state.doc).toBeNull();
    expect(api.state.filter).toBeNull();
    expect(location.pathname).toBe('/home/');
  });

  it('leaves a newer exact jump in place when the older read finishes last', async () => {
    const { api, finish } = await setup();
    const oldJump = api.jumpToEntry(earlier), newJump = api.jumpToEntry(newer);
    finish(newer, 1);
    await newJump;
    finish(earlier);
    await oldJump;
    expect(location.pathname).toBe(`/work/${newer}`);
  });

  it('honors Back/Forward intent even when the destination needs no view rebuild', async () => {
    const { api, finish } = await setup();
    const initialJump = api.jumpToEntry(newer);
    finish(newer);
    await initialJump;
    const jumping = api.jumpToEntry(earlier);
    history.pushState({}, '', '/work/');
    await api.handleLocationChange();
    finish(earlier, 1);
    await jumping;
    expect(location.pathname).toBe('/work/');
  });

  it('cancels a pending jump on same-route popstate and deduplicates its following hash event', async () => {
    const { api, finish } = await setup();
    const jumping = api.jumpToEntry(earlier);
    history.replaceState({ anchor: null, engaged: null }, '', '/work/');
    await api.handleLocationChange(new PopStateEvent('popstate', { state: history.state }));
    await api.handleLocationChange(new HashChangeEvent('hashchange'));
    finish(earlier);
    await jumping;
    expect(api.state.doc).toBeNull();
    expect(api.state.filter).toBeNull();
    expect(location.pathname).toBe('/work/');
  });

  it('does not cancel a current jump for a duplicate non-traversal location event', async () => {
    const { api, finish } = await setup();
    const jumping = api.jumpToEntry(earlier);
    await api.handleLocationChange(new HashChangeEvent('hashchange'));
    finish(earlier);
    await jumping;
    expect(location.pathname).toBe(`/work/${earlier}`);
  });
});

// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { Store } from '../lib/store';
import type { Entry, EntityRef } from '../lib/types';
import type { DocRef, ViewState } from '../src/route';
import { loadApp } from './app-harness';

interface App {
  state: { store: Store | null; instanceId: string | null; filter: EntityRef | null; doc: DocRef | null; panelCollapsed: boolean };
  jumpToEntry(id: string): Promise<void>;
  applyView(view: ViewState): Promise<void>;
  clearInstanceView(): void;
  handleLocationChange(event?: Event): Promise<void>;
}

function coldStore() {
  const pending: ((entries: Entry[]) => void)[] = [];
  const store = {
    getWeekEntries: () => new Promise<Entry[]>(resolve => pending.push(resolve)),
    getInstance: () => null,
  } as unknown as Store;
  const finish = (id: string, index = 0) => pending[index]([{ meta: { created: id }, weekFile: '2026-09-28', content: 'Earlier note' }]);
  return { store, finish };
}

afterEach(() => document.body.replaceChildren());

describe('superseded cold note jumps', () => {
  const earlier = '2026-10-04T10:00', newer = '2026-10-04T11:00';

  async function setup() {
    history.replaceState({}, '', '/work/');
    document.body.innerHTML = '<input id="kept-focus"><div id="flow"></div>';
    const api = await loadApp<App>('state, jumpToEntry, applyView, clearInstanceView, handleLocationChange'), cold = coldStore();
    api.state.store = cold.store;
    api.state.instanceId = 'work';
    api.state.panelCollapsed = true;
    await api.applyView({ filter: null, doc: null });
    const input = document.querySelector<HTMLInputElement>('input')!;
    input.focus();
    return { api, ...cold, input };
  }

  it('keeps a newer reader, URL, history entry and focus when an earlier lookup finishes', async () => {
    const { api, finish, input } = await setup();
    const jumping = api.jumpToEntry(earlier);
    await api.applyView({ filter: null, doc: { kind: 'asset', path: 'assets/later.md' } });
    const historyLength = history.length;
    finish(earlier);
    await jumping;
    expect(api.state.doc).toEqual({ kind: 'asset', path: 'assets/later.md' });
    expect(location.pathname).toBe('/work/asset/assets/later.md');
    expect(history.length).toBe(historyLength);
    expect(document.activeElement).toBe(input);
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

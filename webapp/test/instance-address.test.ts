// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadApp } from './app-harness';
import type { AvailableInstance } from '../src/backend';

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); history.replaceState(null, '', '/'); });

async function fixture(instance: AvailableInstance) {
  document.body.innerHTML = '<div id="setting-instance-status" hidden></div>';
  const app = await loadApp<{
    state: { instance: AvailableInstance | null; instanceId: string | null };
    renderInstanceStatus(): void;
    refreshInstanceMetadata(): Promise<void>;
  }>('state, renderInstanceStatus, refreshInstanceMetadata');
  app.state.instance = instance; app.state.instanceId = instance.address ?? instance.id;
  return app;
}

describe('browser addresses and calendar notices', () => {
  it('puts the duplicate ID before calendar policy and keeps its ID monospace', async () => {
    const app = await fixture({ id: 'work', path: '/linked/data', duplicatePaths: ['/linked/data', '/copy'], worktree: {
      linked: true, root: '/linked', commonDir: '/primary/.git', primaryPath: '/primary/data', label: 'feature',
    } });
    app.renderInstanceStatus();
    const messages = [...document.querySelectorAll('.instance-status-message')];
    expect(messages[0].textContent).toContain('Duplicated ID work. Calendar sync is paused');
    expect(messages[0].querySelector('code')?.textContent).toBe('work');
    expect(messages.some(message => message.textContent?.includes('Give distinct instances unique IDs in aside.md'))).toBe(true);
    expect(messages.at(-1)?.textContent).toContain('Calendar sync is disabled for Git worktrees');
  });

  it('shows duplicate warnings with paths, and clears them after resolution', async () => {
    const app = await fixture({ id: 'work', path: '/work', calendarWarning: 'Duplicate instance ID “work”. Calendar sync is paused.\n/work\n/copy' });
    app.renderInstanceStatus();
    expect(document.querySelector('.instance-status-message')?.textContent).toContain('/copy');
    expect(document.querySelector('.instance-status-warning')).not.toBeNull();
    app.state.instance = { id: 'work', path: '/work' }; app.renderInstanceStatus();
    expect((document.querySelector('#setting-instance-status') as HTMLElement).hidden).toBe(true);
  });

  it('shows worktree information without warning styling, including the primary path', async () => {
    const app = await fixture({ id: 'work', path: '/linked/data', worktree: {
      linked: true, root: '/linked', commonDir: '/primary/.git', primaryPath: '/primary/data', label: 'feature',
    } });
    app.renderInstanceStatus();
    expect(document.querySelector('#setting-instance-status')?.textContent).toContain('Move these changes into the primary checkout');
    expect(document.querySelector('#setting-instance-status')?.textContent).toContain('/primary/data');
    expect(document.querySelector('.instance-status-warning')).toBeNull();
  });

  it('changes an open bare URL to its exact alias on conflict and back after resolution, preserving the view', async () => {
    const alias = 'work~1111111111111111';
    const instance = { id: 'work', address: 'work', alias, path: '/work' };
    const app = await fixture(instance);
    history.replaceState({ anchor: 'preserve' }, '', '/work/action/2026-10-05-review/detail?mode=detail#section');
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...instance, address: alias, calendarWarning: 'Calendar sync is paused' }))
      .mockResolvedValueOnce(Response.json(instance));
    vi.stubGlobal('fetch', fetch);
    await app.refreshInstanceMetadata();
    expect(location.pathname).toBe(`/${alias}/action/2026-10-05-review/detail`);
    expect(location.search).toBe('?mode=detail'); expect(location.hash).toBe('#section');
    expect(history.state).toEqual({ anchor: 'preserve' });
    expect(fetch.mock.calls[0][0]).toBe(`/-/api/instances/${alias}`);
    await app.refreshInstanceMetadata();
    expect(location.pathname).toBe('/work/action/2026-10-05-review/detail');
  });

  it('does not install late metadata after selection changes', async () => {
    const instance = { id: 'work', alias: 'work~1111111111111111', path: '/work' };
    const app = await fixture(instance);
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const refreshing = app.refreshInstanceMetadata();
    app.state.instance = { id: 'personal', path: '/personal' };
    app.state.instanceId = 'personal';
    history.replaceState(null, '', '/personal/');
    finish(Response.json({ ...instance, address: instance.alias })); await refreshing;
    expect(app.state.instanceId).toBe('personal'); expect(location.pathname).toBe('/personal/');
  });
});

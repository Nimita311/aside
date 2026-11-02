import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonDataSource, daemonRequest, loadDaemonInstance } from '../src/backend';

import { snapshotFixture } from './snapshot-fixture';
const fileKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function fileResponse(url: string): Response {
  if (url.endsWith('/years')) return Response.json(['2026']);
  if (url === '/-/api/instances/work') return Response.json({ id: 'work', name: 'Work', path: '/fixture/work' });
  if (url.includes('/data')) return Response.json(snapshotFixture(), { headers: { ETag: '"data-v1"' } });
  if (url.endsWith('/access')) return Response.json({ fileBase: '/-/files/00000000-0000-4000-8000-000000000001/work', fileKey });
  return new Response('', { status: 404 });
}

afterEach(() => vi.unstubAllGlobals());

describe('daemon browser source', () => {
  it('pins reads to the path alias when a duplicate appears during loading', async () => {
    const alias = 'work~1111111111111111';
    const request = vi.fn(async (url: string) => {
      if (url === '/-/api/instances/work') return Response.json({ id: 'work', address: 'work', alias, path: '/fixture/work' });
      if (url === `/-/api/instances/${alias}`) return Response.json({ id: 'work', address: alias, alias, path: '/fixture/work', calendarWarning: 'Calendar sync is paused' });
      if (url.endsWith('/access')) return Response.json({ fileBase: `/-/files/00000000-0000-4000-8000-000000000001/${alias}`, fileKey });
      return fileResponse(url.replace(alias, 'work'));
    });
    vi.stubGlobal('fetch', request);
    const { instance, source, store } = await loadDaemonInstance('work');
    expect(instance.address).toBe(alias); expect(instance.id).toBe('work');
    expect(store.getInstance()?.manifest.id).toBe('work');
    expect(source.assetUrl('assets/photo.png')).toContain(`/00000000-0000-4000-8000-000000000001/${alias}/`);
    expect(source.assetUrl('assets/photo.png')).toContain('/files/assets/photo.png');
    expect(request.mock.calls.filter(([url]) => url.startsWith('/-/api/instances/work/'))).toEqual([]);
    expect(request.mock.calls.at(-1)?.[0]).toBe(`/-/api/instances/${alias}`);
  });
  it('scopes file reads, media URLs, years and watches to the selected instance', async () => {
    const request = vi.fn().mockResolvedValue(new Response('["2010","2037"]', { status: 200 }));
    vi.stubGlobal('fetch', request);
    const source = new DaemonDataSource('work', '/-/files/00000000-0000-4000-8000-000000000001/work', fileKey);
    expect(await source.listYears()).toEqual(['2010', '2037']);
    expect(request.mock.calls[0][0]).toBe('/-/api/instances/work/years');
    expect(source.assetUrl('assets/photo #1.png')).toMatch(/^\/-\/files\/00000000-0000-4000-8000-000000000001\/work\/.+\/files\/assets\/photo%20%231\.png$/);
    request.mockResolvedValue(new Response('work bytes', { status: 200, headers: { ETag: '"work-v1"' } }));
    expect((await source.read('aside.md'))?.text).toBe('work bytes');
    expect(request.mock.calls[1][0]).toBe('/-/api/instances/work/files/aside.md');
    request.mockResolvedValue(new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }));
    source.watch(() => {})();
    expect(request.mock.calls[2][0]).toBe('/-/api/instances/work/watch');
    expect(new Headers(request.mock.calls[2][1].headers).get('Authorization')).toBe('Bearer fixture-browser-token');
    expect(new DaemonDataSource('home', '/-/files/00000000-0000-4000-8000-000000000001/home', fileKey).assetUrl('assets/photo #1.png')).toContain('/00000000-0000-4000-8000-000000000001/home/');
  });

  it('reports unavailable and ambiguous instances with all paths', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Duplicate instance id', paths: ['/one', '/two'] }), { status: 409 })));
    await expect(daemonRequest('instances/work')).rejects.toThrow('Duplicate instance id\n/one\n/two');
  });

  it('does not turn a failed core snapshot request into an empty instance', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/data')) throw new Error('Connection lost');
      return fileResponse(url);
    }));
    await expect(loadDaemonInstance('work')).rejects.toThrow('Connection lost');
  });

  it.each(['actions/2026/2026-10-04-task.md', 'actions/2026/index.yaml', 'notes/2026/index.yaml'])('opens readable records with a retryable diagnostic when %s fails', async failedPath => {
    let failing = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/data')) {
        const data = snapshotFixture();
        if (failing) data.diagnostics.push({ path: failedPath, issues: [{ severity: 'error', code: 'read_error', message: 'Unreadable fixture', file: failedPath }] });
        return Response.json(data, { headers: { ETag: failing ? '"partial"' : '"repaired"' } });
      }
      return fileResponse(url);
    }));
    const { instance, store } = await loadDaemonInstance('work');
    expect(instance.id).toBe('work');
    expect(store.getInstance()?.manifest.id).toBe('work');
    expect(store.getProjectIndex()).toHaveLength(1);
    expect(store.getDisplayName('project', '2026-10-04-program')).toBe('Good program');
    expect(store.getDiagnostics()).toMatchObject([{ path: failedPath, issues: [{ code: 'read_error' }] }]);
    if (!failedPath.startsWith('notes/')) {
      expect(store.getNoteIndex()).toHaveLength(1);
      expect((await store.getWeekEntries('2026-09-28'))[0].content).toBe('Good note body.');
    }
    failing = false;
    await store.reloadFile(failedPath);
    expect(store.getDiagnostics()).toEqual([]);
    expect(store.getNoteIndex()).toHaveLength(1);
    expect(store.getDisplayName('action', '2026-10-04-task')).toBe('Good task');
  });

  it('loads records, graph, filters and search text from one structured request without reading record files', async () => {
    const request = vi.fn(async (url: string) => fileResponse(url));
    vi.stubGlobal('fetch', request);
    const { store } = await loadDaemonInstance('work');
    expect((await store.getWeekEntries('2026-09-28'))[0].content).toBe('Good note body.');
    expect(await store.getProject('2026-10-04-program')).toEqual(store.getCachedProject('2026-10-04-program'));
    expect(store.filterWeeks({ type: 'entry', id: '2026-10-04T10:00' })).toEqual(['2026-09-28']);
    expect(store.getCachedEntryContents().get('2026-10-04T10:00')).toBe('Good note body.');
    await store.getRelations(); await store.warmSearch();
    expect(request.mock.calls.map(call => call[0])).toEqual(['/-/api/instances/work', '/-/api/instances/work/access', '/-/api/instances/work/data', '/-/api/instances/work']);
  });

  it('rejects an unavailable daemon before loading records', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Daemon unavailable'));
    vi.stubGlobal('fetch', request);
    await expect(loadDaemonInstance('work')).rejects.toThrow('Daemon unavailable');
    expect(request.mock.calls.map(call => call[0])).toEqual(['/-/api/instances/work']);
  });

  it.each([404, 409])('rejects identity loss or ambiguity discovered after records load (%s)', async status => {
    let checks = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/-/api/instances/work' && ++checks === 2) return Response.json({ error: 'Instance became unavailable or ambiguous' }, { status });
      return fileResponse(url);
    }));
    await expect(loadDaemonInstance('work')).rejects.toThrow('Instance became unavailable or ambiguous');
    expect(checks).toBe(2);
  });
});

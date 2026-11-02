import { describe, expect, it, vi } from 'vitest';
import { RemoteStore, type SnapshotSource } from '../lib/remote-store';
import { snapshotFixture } from './snapshot-fixture';
import type { DataSnapshot } from '../../cli/src/core/data-snapshot';

function fixture() {
  let data = snapshotFixture();
  let version = '1';
  const source: SnapshotSource = {
    snapshot: vi.fn(async old => old === version ? 'unchanged' : { value: structuredClone(data), version }),
    read: vi.fn(async () => ({ text: 'Attachment', version: 'asset-1' })),
    revalidate: vi.fn(async () => 'unchanged' as const),
    assetUrl: path => `/files/${path}`, assetVersion: vi.fn(async () => 'media-1'),
  };
  return { source, update: (next: DataSnapshot) => { data = next; version = String(Number(version) + 1); } };
}
const hot = { weeks: [], entities: [], assets: [] };

describe('daemon presentation cache', () => {
  it('stages complete snapshots and applies records, graph, search and diagnostics together', async () => {
    const { source, update } = fixture();
    const store = new RemoteStore(source); await store.init();
    const next = snapshotFixture('work', 'Edited');
    next.actions = []; next.indexes.actions = [];
    next.relations.entriesByEntity = [['#project/p', ['2026-10-04T10:00']]];
    next.weeksByEntity.push(['#project/p', ['2026-09-28']]);
    next.diagnostics = [{ path: 'aside.md', issues: [{ severity: 'warning', code: 'fixture', message: 'Check me' }] }];
    update(next);
    const staged = await store.check('light', hot);
    expect(store.getCachedEntryContents().get('2026-10-04T10:00')).toBe('Good note body.');
    expect(store.getDiagnostics()).toEqual([]);
    staged!.apply();
    expect(store.getCachedEntryContents().get('2026-10-04T10:00')).toBe('Edited');
    expect(store.getCachedAction('2026-10-04-task')).toBeUndefined();
    expect((await store.getRelations()).entriesByEntity.get('#project/p')).toEqual(['2026-10-04T10:00']);
    expect(store.filterWeeks({ type: 'project', id: 'p' })).toEqual(['2026-09-28']);
    expect(store.getDiagnostics()).toEqual(next.diagnostics);
    expect(staged!.summary.entities.has('#action/2026-10-04-task')).toBe(true);
    expect(await store.check('light', hot)).toBeNull();
    expect(source.read).not.toHaveBeenCalled();
  });
  it('preserves readable records on transport failure and rejects an older staged result after Retry', async () => {
    const { source, update } = fixture();
    const store = new RemoteStore(source); await store.init();
    vi.mocked(source.snapshot).mockRejectedValueOnce(new Error('Offline'));
    await expect(store.check('light', hot)).rejects.toThrow('Offline');
    expect(store.getCachedProject('2026-10-04-program')).toBeDefined();
    update(snapshotFixture('work', 'Older'));
    const older = await store.check('light', hot);
    update(snapshotFixture('work', 'Newer'));
    await store.reloadFile('notes/2026/2026-09-28.md');
    older!.apply();
    expect(store.getCachedEntryContents().get('2026-10-04T10:00')).toBe('Newer');
  });
  it('keeps cached text on a failed Retry and coalesces first reads', async () => {
    const { source } = fixture();
    const store = new RemoteStore(source); await store.init();
    const first = store.getAsset('assets/notes.md');
    const second = store.getAsset('assets/notes.md');
    expect(first).toBe(second);
    await first;
    vi.mocked(source.read).mockRejectedValueOnce(new Error('Offline'));
    await expect(store.reloadFile('assets/notes.md')).rejects.toThrow('Offline');
    expect(await store.getAsset('assets/notes.md')).toBe('Attachment');
    expect(store.diagnosticsFor('assets/notes.md')?.error).toBe('Offline');
  });
  it('fences a pending first read when a pushed deletion is applied', async () => {
    const { source } = fixture();
    const store = new RemoteStore(source); await store.init();
    let finish!: (value: { text: string; version: string }) => void;
    vi.mocked(source.read).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(null);
    const pending = store.getAsset('assets/notes.md');
    const rejected = expect(pending).rejects.toThrow('Asset file not found');
    const staged = await store.check('light', hot, ['assets/notes.md']);
    staged!.apply();
    finish({ text: 'Deleted old text', version: 'old' });
    await rejected;
    expect(staged!.summary.assets.has('assets/notes.md')).toBe(true);
  });
  it('refreshes displayed supporting text and binary URLs independently of the core snapshot', async () => {
    const { source } = fixture();
    const store = new RemoteStore(source); await store.init();
    await store.getAsset('assets/notes.md');
    await store.prepareAssetUrl('assets/image.png');
    vi.mocked(source.revalidate).mockResolvedValueOnce({ text: 'Revised attachment', version: 'asset-2' });
    vi.mocked(source.assetVersion!).mockResolvedValueOnce('media-2');
    const staged = await store.check('full', hot);
    expect(staged!.summary.assets).toEqual(new Set(['assets/notes.md', 'assets/image.png']));
    expect(await store.getAsset('assets/notes.md')).toBe('Attachment');
    staged!.apply();
    expect(await store.getAsset('assets/notes.md')).toBe('Revised attachment');
    expect(store.assetUrl('assets/image.png')).toContain('aside_revision=1');
    expect(source.read).toHaveBeenCalledTimes(1);
  });
  it('tracks images embedded by URL and refreshes them without reading binary contents', async () => {
    const { source } = fixture();
    const store = new RemoteStore(source); await store.init();
    expect(store.assetUrl('assets/embedded.png')).toBe('/files/assets/embedded.png');
    const initial = await store.check('light', { ...hot, assets: ['assets/embedded.png'] });
    initial!.apply();
    const before = store.assetUrl('assets/embedded.png');
    vi.mocked(source.assetVersion!).mockResolvedValueOnce('media-2');
    const changed = await store.check('light', hot, ['assets/embedded.png']);
    changed!.apply();
    expect(changed!.summary.assets.has('assets/embedded.png')).toBe(true);
    expect(store.assetUrl('assets/embedded.png')).not.toBe(before);
    expect(source.read).not.toHaveBeenCalled();
  });
  it('keeps core attachment diagnostics through successful byte reads and removes them after repair', async () => {
    const { source, update } = fixture();
    const next = snapshotFixture();
    next.diagnostics = [{ path: 'assets/notes.md', issues: [{ severity: 'warning', code: 'artifact_reference_missing', message: 'Missing reference' }] }];
    update(next);
    const store = new RemoteStore(source); await store.init();
    await store.getAsset('assets/notes.md');
    expect(store.diagnosticsFor('assets/notes.md')?.issues).toEqual(next.diagnostics[0].issues);
    update(snapshotFixture());
    (await store.check('light', hot))!.apply();
    expect(store.getDiagnostics()).toEqual([]);
  });
  it('clears a transient asset error after a successful unchanged check and requests a repaint', async () => {
    const { source } = fixture();
    const store = new RemoteStore(source); await store.init();
    await store.getAsset('assets/notes.md');
    store.reportAssetFailure('assets/notes.md', new Error('Offline'));
    const checked = await store.check('full', hot);
    expect(store.diagnosticsFor('assets/notes.md')?.error).toBe('Offline');
    checked!.apply();
    expect(checked!.summary.assets.has('assets/notes.md')).toBe(true);
    expect(store.getDiagnostics()).toEqual([]);
  });
  it('does not allow a pending HEAD to overwrite newer media metadata from a check', async () => {
    const { source } = fixture();
    const store = new RemoteStore(source); await store.init();
    let finish!: (version: string) => void;
    vi.mocked(source.assetVersion!).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue('media-2');
    const pending = store.prepareAssetUrl('assets/image.png');
    const checked = await store.check('full', hot); checked!.apply();
    finish('media-1'); await pending;
    expect(await store.check('full', hot)).toBeNull();
  });
  it('does not let an older failed check replace a successful asset Retry', async () => {
    const { source } = fixture();
    const store = new RemoteStore(source); await store.init();
    await store.getAsset('assets/notes.md');
    let fail!: (error: Error) => void;
    vi.mocked(source.revalidate).mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
    const checking = store.check('full', hot);
    await vi.waitFor(() => expect(fail).toBeDefined());
    await store.reloadFile('assets/notes.md');
    fail(new Error('Old failure')); await checking;
    expect(store.getDiagnostics()).toEqual([]);
  });
  it('bounds media checks even after scrolling through many images', async () => {
    const { source } = fixture();
    const store = new RemoteStore(source); await store.init();
    for (let i = 0; i < 20; i++) store.assetUrl(`assets/image-${i}.png`);
    let active = 0, maximum = 0;
    const finish: (() => void)[] = [];
    vi.mocked(source.assetVersion!).mockImplementation(() => new Promise(resolve => {
      active++; maximum = Math.max(maximum, active);
      finish.push(() => { active--; resolve('media-1'); });
    }));
    const checking = store.check('full', hot);
    await vi.waitFor(() => expect(finish.length).toBe(6));
    while (active) {
      finish.splice(0).forEach(resolve => resolve());
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    (await checking)!.apply();
    expect(maximum).toBe(6);
    expect(source.read).not.toHaveBeenCalled();
  });

});

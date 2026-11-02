// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import type { DataSource, FileRead } from '../lib/io';
import { emptyFlowKind, renderEmptyFlow, starterPrompt } from '../src/onboarding';

const instance = { id: 'work', name: 'Work', path: '/fixtures/Aside work' };
const manifest = '---\nid: work\nname: Work\n---';
class Source implements DataSource {
  failing = new Set<string>();
  constructor(public files: Record<string, string> = { 'aside.md': manifest }) {}
  async read(path: string): Promise<FileRead | null> { if (this.failing.has(path)) throw new Error('Offline'); const text = this.files[path]; return text === undefined ? null : { text, version: text }; }
  async revalidate(path: string, version: string) { const file = await this.read(path); return file?.version === version ? 'unchanged' as const : file; }
  async listYears() { return ['2026']; }
  assetUrl() { return null; }
}
afterEach(() => { document.body.replaceChildren(); });
describe('verified empty views', () => {
  it('shows onboarding only after clean successful initialization and traversal', async () => {
    const store = new Store(new Source());
    expect(store.isVerifiedEmpty()).toBe(false); expect(emptyFlowKind(store, null, true, false)).toBeNull();
    await store.init(); expect(store.isVerifiedEmpty()).toBe(true);
    expect(emptyFlowKind(store, null, false, false)).toBeNull();
    expect(emptyFlowKind(store, null, true, true)).toBeNull();
    expect(emptyFlowKind(store, null, true, false)).toBe('instance');
  });
  it('distinguishes a project-only timeline and an exhausted filter from whole-instance emptiness', async () => {
    const source = new Source({ 'aside.md': manifest, 'projects/2026/index.yaml': '- id: 2026-05-22-work', 'projects/2026/2026-05-22-work.md': '---\nname: Work\ncreated: 2026-05-22T15:30\n---' });
    const store = new Store(source); await store.init();
    expect(store.getNoteIndex()).toEqual([]); expect(store.isVerifiedEmpty()).toBe(false);
    expect(emptyFlowKind(store, null, true, false)).toBe('timeline');
    expect(emptyFlowKind(store, { type: 'project', id: '2026-05-22-work' }, true, false)).toBe('filter');
    const clear = vi.fn(); const filtered = renderEmptyFlow('filter', instance, { clearFilter: clear, hasNotes: false });
    expect(filtered.textContent).toContain('No entries match this filter.'); expect(filtered.textContent).not.toContain('stage');
    filtered.querySelector('button')!.click(); expect(clear).toHaveBeenCalledOnce();
    expect(renderEmptyFlow('timeline', instance, { clearFilter: clear, hasNotes: false }).textContent).toBe('No notes yet.');
  });
  it('keeps failed or malformed indexes/manifests out of every empty claim until corrected retry succeeds', async () => {
    const source = new Source({ 'aside.md': '---\nname: [\n---', 'notes/2026/index.yaml': 'not: [valid' });
    const store = new Store(source); await store.init();
    expect(store.getNoteIndex()).toEqual([]); expect(store.isVerifiedEmpty()).toBe(false);
    expect(emptyFlowKind(store, null, true, false)).toBeNull();
    expect(emptyFlowKind(store, { type: 'action', id: '2026-05-22-work' }, true, false)).toBeNull();
    source.files['aside.md'] = manifest; source.files['notes/2026/index.yaml'] = '[]';
    await store.reloadFile('aside.md'); await store.reloadFile('notes/2026/index.yaml');
    expect(store.isVerifiedEmpty()).toBe(true);
    source.failing.add('actions/2026/index.yaml'); await expect(store.reloadFile('actions/2026/index.yaml')).rejects.toThrow('Offline');
    expect(emptyFlowKind(store, null, true, false)).toBeNull();
    const unavailable = new Source(); unavailable.listYears = async () => { throw new Error('Cannot discover history'); };
    const failed = new Store(unavailable); await expect(failed.init()).rejects.toThrow('Cannot discover history');
    expect(failed.isVerifiedEmpty()).toBe(false); expect(emptyFlowKind(failed, null, true, false)).toBeNull();
    const missing = new Store(new Source({})); await missing.init();
    expect(missing.isVerifiedEmpty()).toBe(false); expect(emptyFlowKind(missing, null, true, false)).toBeNull();
  });
  it('copies the canonical destination and exposes concise guidance without creating records', async () => {
    const copy = vi.fn(async (_text: string) => {});
    const host = renderEmptyFlow('instance', instance, { clearFilter: vi.fn(), hasNotes: false, copy }); document.body.append(host);
    expect(host.textContent).toContain('The stage is yours.');
    expect(host.textContent).toContain('Ask your agent to capture a note, organize a project, or plan an action. Your records will appear here.');
    expect(host.textContent).toContain(instance.path);
    host.querySelector<HTMLButtonElement>('button')!.click(); await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce());
    expect(copy).toHaveBeenCalledWith(starterPrompt(instance)); expect(copy.mock.calls[0][0]).toContain('select_instance tool with path "/fixtures/Aside work"');
    expect(copy.mock.calls[0][0]).toContain('browser selection is independent');
    await vi.waitFor(() => expect(host.querySelector('[role="status"]')?.textContent).toBe('Starter prompt copied.'));
    const guide = host.querySelector('details')!; expect(guide.querySelector('summary')?.textContent).toBe('Getting started');
    expect(guide.querySelectorAll('li')).toHaveLength(3);
  });
  it('leaves a selected prompt available when clipboard access fails', async () => {
    const host = renderEmptyFlow('instance', { ...instance, path: '/fixtures/Aside "quoted"' }, { clearFilter: vi.fn(), hasNotes: false, copy: async () => { throw new Error('denied'); } }); document.body.append(host);
    host.querySelector<HTMLButtonElement>('button')!.click();
    const manual = host.querySelector('textarea')!;
    await vi.waitFor(() => expect(manual.hidden).toBe(false));
    expect(document.activeElement).toBe(manual); expect(manual.selectionEnd - manual.selectionStart).toBe(manual.value.length);
    expect(manual.value).toContain(JSON.stringify('/fixtures/Aside "quoted"')); expect(manual.readOnly).toBe(true);
  });
});

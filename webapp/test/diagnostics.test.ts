// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../lib/store';
import type { DataSource, FileRead } from '../lib/io';
import { documentFilePath } from '../src/document-path';
import { fileDiagnosticNotice } from '../src/diagnostics';
const WEEK = 'notes/2026/2026-05-18.md';
const good = '---\nweek: 21\nweek_start: 2026-05-18\nweek_end: 2026-05-24\n---\n\n---\n```entry\ncreated: 2026-05-22T15:30\n```\nRecovered content';
class Source implements DataSource {
  failing = new Set<string>();
  constructor(public files: Record<string, string>) {}
  async read(path: string): Promise<FileRead | null> { if (this.failing.has(path)) throw new Error('Offline'); const text = this.files[path]; return text === undefined ? null : { text, version: text }; }
  async revalidate(path: string, version: string) { const read = await this.read(path); return read?.version === version ? 'unchanged' as const : read; }
  async listYears() { return ['2026']; }
  assetUrl() { return null; }
}
describe('retained parser diagnostics', () => {
  it('maps entry documents to their weekly file and keeps entity/artifact/asset identities distinct', () => {
    expect(documentFilePath({ kind: 'detail' }, { type: 'entry', id: '2026-05-22T15:30' })).toBe(WEEK);
    expect(documentFilePath({ kind: 'detail' }, null)).toBe('aside.md');
    expect(documentFilePath({ kind: 'detail' }, { type: 'project', id: '2026-05-22-work' })).toBe('projects/2026/2026-05-22-work.md');
    expect(documentFilePath({ kind: 'detail' }, { type: 'action', id: '~2026-05-22-repeat@2027-01-01' })).toBe('actions/2026/2026-05-22-repeat.md');
    expect(documentFilePath({ kind: 'artifact', id: '2026-05-22-report' }, null)).toBe('artifacts/2026/2026-05-22-report.md');
    expect(documentFilePath({ kind: 'asset', path: 'assets/notes.md' }, null)).toBe('assets/notes.md');
  });
  it('does not report an obsolete read failure after a newer check installed the record', async () => {
    const path = 'projects/2026/2026-05-22-work.md';
    const source = new Source({ [path]: '---\nname: Current\ncreated: 2026-05-22T15:30\n---' });
    const original = source.read.bind(source); let failOld!: (error: Error) => void; let first = true;
    source.read = async file => {
      if (file === path && first) { first = false; return await new Promise<FileRead>((_, reject) => { failOld = reject; }); }
      return original(file);
    };
    const store = new Store(source); const old = store.getProject('2026-05-22-work');
    const update = await store.check('light', { weeks: [], entities: [{ kind: 'project', id: '2026-05-22-work' }], assets: [] }); update!.apply();
    failOld(new Error('Obsolete failure')); expect((await old).frontMatter.name).toBe('Current');
    expect(store.diagnosticsFor(path)).toBeUndefined();
  });
  it('retains useful weekly content plus file issues and clears them on corrected reload', async () => {
    const source = new Source({ [WEEK]: good + '\n\n---\n```entry\ncreated: 2026-05-19T09:00' });
    const store = new Store(source); const entries = await store.getWeekEntries('2026-05-18');
    expect(entries.map(entry => entry.content)).toEqual(['Recovered content']);
    const diagnostic = store.diagnosticsFor(WEEK)!;
    expect(diagnostic.issues.some(issue => issue.code === 'unterminated_entry_block' && issue.file === WEEK)).toBe(true);
    const notice = fileDiagnosticNotice(diagnostic, vi.fn());
    expect(notice.textContent).toContain(WEEK); expect(notice.textContent).toContain('unterminated'); expect(notice.querySelector('button')?.getAttribute('aria-label')).toBe(`Retry ${WEEK}`);
    source.files[WEEK] = good;
    await store.reloadFile(WEEK);
    expect(store.diagnosticsFor(WEEK)).toBeUndefined(); expect((await store.getWeekEntries('2026-05-18'))).toHaveLength(1);
  });
  it('does not treat invalid indexes or manifests with recovered zero rows as clean data', async () => {
    const source = new Source({ 'aside.md': '---\nname: [\n---', 'notes/2026/index.yaml': 'not: [valid' });
    const store = new Store(source); await store.init();
    expect(store.getNoteIndex()).toEqual([]);
    expect(store.getDiagnostics().map(diagnostic => diagnostic.path)).toEqual(expect.arrayContaining(['aside.md', 'notes/2026/index.yaml']));
    source.files['aside.md'] = '---\nid: work\nname: Work\n---'; source.files['notes/2026/index.yaml'] = '[]';
    await store.reloadFile('aside.md'); await store.reloadFile('notes/2026/index.yaml');
    expect(store.getDiagnostics()).toEqual([]);
  });
  it('keeps parse diagnostics paired with staged content until apply, and preserves recovered data on a failed retry', async () => {
    const source = new Source({ [WEEK]: good }); const store = new Store(source); await store.getWeekEntries('2026-05-18');
    source.files[WEEK] += '\n\n---\n```entry\ncreated: 2026-05-19T09:00';
    const staged = await store.check('light', { weeks: ['2026-05-18'], entities: [], assets: [] });
    expect(store.diagnosticsFor(WEEK)).toBeUndefined(); staged!.apply();
    expect(store.diagnosticsFor(WEEK)?.issues.length).toBeGreaterThan(0);
    source.failing.add(WEEK); await expect(store.reloadFile(WEEK)).rejects.toThrow('Offline');
    expect(store.diagnosticsFor(WEEK)?.error).toBe('Offline');
    expect((await store.getWeekEntries('2026-05-18'))[0].content).toBe('Recovered content');
  });
});

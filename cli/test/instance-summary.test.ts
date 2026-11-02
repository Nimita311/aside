import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../src/mcp/store.js';
import { instanceCardSummary } from '../src/web/summary.js';

let root: string;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
describe('instance card summary', () => {
  it('includes directory edits so deleting a record updates last edit', () => {
    root = mkdtempSync('/tmp/aside-card-summary-');
    writeFileSync(join(root, 'aside.md'), '---\nid: work\n---\n');
    const attachments = join(root, 'artifacts', '2026', '2026-10-07-report'); mkdirSync(attachments, { recursive: true });
    const file = join(attachments, 'attachment.pdf'); writeFileSync(file, 'Attachment');
    const store = new Store(root), edited = new Date('2030-10-07T20:00:00Z');
    utimesSync(file, edited, edited);
    expect(instanceCardSummary(store).lastEdited).toBe(edited.toISOString());
    rmSync(file);
    const deleted = new Date('2030-10-08T20:00:00Z'); utimesSync(attachments, deleted, deleted);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1001);
    expect(instanceCardSummary(store).lastEdited).toBe(deleted.toISOString());
  });

  it('does not treat user file locations or workspace configuration as managed data edits', () => {
    root = mkdtempSync('/tmp/aside-card-summary-');
    const manifest = join(root, 'aside.md');
    writeFileSync(manifest, '---\nid: work\n---\n');
    const edited = new Date('2030-10-07T20:00:00Z');
    utimesSync(manifest, edited, edited);
    const later = new Date('2030-10-08T20:00:00Z');
    for (const name of ['assets', 'my-files', 'projects/reference', 'projects/2026/support', 'artifacts/2026/2026-10-07-report/nested']) {
      const directory = join(root, name); mkdirSync(directory, { recursive: true });
      const file = join(directory, 'report.md'); writeFileSync(file, 'User-organized content');
      utimesSync(file, later, later);
      utimesSync(directory, later, later);
    }
    const config = join(root, '.aside'); writeFileSync(config, 'discovery: false\n');
    utimesSync(config, later, later);
    const store = new Store(root);
    expect(instanceCardSummary(store).lastEdited).toBe(edited.toISOString());
    store.close();
  });

  it('matches indexed open/total counts and gets last edit from metadata including attachments', () => {
    root = mkdtempSync('/tmp/aside-card-summary-');
    writeFileSync(join(root, 'aside.md'), '---\nid: work\n---\n');
    for (const kind of ['projects', 'actions']) {
      const year = join(root, kind, '2026'); mkdirSync(year, { recursive: true });
      const ids = ['2026-10-01-open', '2026-10-02-closed'];
      writeFileSync(join(year, 'index.yaml'), ids.map(id => `- id: ${id}\n`).join(''));
      for (const [index, id] of ids.entries()) writeFileSync(join(year, `${id}.md`), `---\nname: Record\ncreated: 2026-10-01T10:00\n${index ? kind === 'projects' ? 'ended: 2026-10-02T10:00\n' : 'resolution: done\n' : ''}---\n`);
      writeFileSync(join(year, '2026-10-03-unindexed.md'), '---\nname: Unindexed\ncreated: 2026-10-03T10:00\n---\n');
    }
    const store = new Store(root);
    const attachments = join(root, 'artifacts', '2026', '2026-10-01-report'); mkdirSync(attachments, { recursive: true });
    const file = join(attachments, 'report.pdf'); writeFileSync(file, 'Attachment');
    const edited = new Date('2030-10-07T20:00:00Z'); utimesSync(file, edited, edited);
    symlinkSync(root, join(attachments, 'cycle'));
    const summary = instanceCardSummary(store);
    expect(summary).toMatchObject({ projects: { open: 1, total: 2 }, actions: { open: 1, total: 2 }, entries: 0, lastEdited: edited.toISOString() });
    expect(instanceCardSummary(store)).toBe(summary);
    const later = new Date('2030-10-08T20:00:00Z'); utimesSync(file, later, later);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1001);
    expect(instanceCardSummary(store).lastEdited).toBe(later.toISOString());
  });
});

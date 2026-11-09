import {sourceFileAccessGuard as access} from './support/source-file-access-guard.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../src/source/store.js';
import {DataCore} from '../src/core/data-core.js';
import {sourceHealthPublication} from '../src/source/source-health.js';

const action = '2026-10-31-action', artifact = '2026-10-31-artifact', created = '2026-10-31T09:00';
const weekly = 'notes/2026/2026-10-26.md';
const weekHeader = '---\nweek: 44\nweek_start: 2026-10-26\nweek_end: 2026-11-01\n---\n';
const validEntry = `\n---\n\`\`\`entry\ncreated: ${created}\n\`\`\`\nReadable entry.\n`;

describe('source-owned published health', () => {
  let root: string, store: Store;
  beforeEach(() => {
    root = mkdtempSync('/private/tmp/aside-source-health-');
    for (const kind of ['notes', 'projects', 'actions', 'artifacts']) mkdirSync(join(root, kind, '2026'), {recursive: true});
    writeFileSync(join(root, 'aside.md'), '---\nid: source-health\nname: Source health\n---\nInstructions.\n');
    writeFileSync(join(root, weekly), weekHeader + validEntry);
    writeFileSync(join(root, 'actions/2026', `${action}.md`), '---\nname: Action\ncreated: 2026-10-31\n---\nAction body.\n');
    writeFileSync(join(root, 'artifacts/2026', `${artifact}.md`), '---\nname: Artifact\ncreated: 2026-10-31\n---\nPrompt body.\n');
    store = new Store(root);
  });
  afterEach(() => {access.reset(); vi.restoreAllMocks(); store?.close(); rmSync(root, {recursive: true, force: true});});

  it('caches immutable health and diagnostics without source I/O until owner publication', () => {
    const health = store.getSourceHealth(), manifest = store.getManifestSourceHealth();
    const record = store.getRecordSourceHealth('action', action), diagnostics = store.getRecordIssues('action', action);
    writeFileSync(join(root, 'aside.md'), '---\nid: [broken\n---\n');
    access.protect([root]);
    for (let i = 0; i < 20; i++) {
      expect(store.getSourceHealth()).toBe(health);
      expect(store.getManifestSourceHealth()).toBe(manifest);
      expect(store.getRecordSourceHealth('action', action)).toBe(record);
      expect(store.getRecordIssues('action', action)).toBe(diagnostics);
    }
    expect(health.complete).toBe(true);
    expect(() => (health as {complete: boolean}).complete = false).toThrow(TypeError);
    expect(() => (record.issues as unknown[]).push({})).toThrow(TypeError);
    expect(access.violations).toEqual([]);
    access.reset(); store.rebuild();
    expect(store.getSourceHealth()).not.toBe(health);
    expect(store.getManifestSourceHealth().issue?.code).toBe('invalid_yaml');
    expect(health.complete).toBe(true);
  });

  it('retains readable records but marks a partial action read incomplete', () => {
    const file = store.getActionFile(action)!;
    unlinkSync(file); symlinkSync(join(root, 'missing-action.md'), file);
    store.rebuild();
    expect(store.getAction(action)?.body).toBe('Action body.');
    expect(store.getSourceHealth().complete).toBe(false);
    expect(store.getRecordSourceHealth('action', action).issue?.code).toBe('read_error');
    expect(store.getRecordSourceHealth('action', 'unobserved-record').complete).toBe(false);
    expect(store.getManifestSourceHealth().complete).toBe(true);
    expect(store.getRecordSourceHealth('artifact', artifact).complete).toBe(true);
  });

  it('publishes manifest read uncertainty without treating it as a confirmed identity transition', () => {
    const file = join(root, 'aside.md');
    unlinkSync(file); mkdirSync(file);
    store.rebuild();
    expect(store.getManifestSourceHealth().complete).toBe(false);
    expect(store.getManifestSourceHealth().issue?.code).toBe('read_error');
    expect(store.getSourceHealth().complete).toBe(false);
    expect(store.getRecordSourceHealth('action', action).complete).toBe(true);
  });

  it('owns malformed record YAML health while preserving unrelated record availability', () => {
    writeFileSync(store.getActionFile(action)!, '---\nname: [broken\n---\nAction body.\n');
    store.rebuild();
    expect(store.getSourceHealth().issue?.code).toBe('invalid_yaml');
    expect(store.getRecordSourceHealth('action', action).issue?.code).toBe('invalid_yaml');
    expect(store.getRecordSourceHealth('artifact', artifact).complete).toBe(true);
    expect(store.getRecordIssues('action', action).some(issue => issue.code === 'invalid_yaml')).toBe(true);
  });

  it.each([
    ['missing entry identity', '\n---\n```entry\nprojects: []\n```\nOmitted entry.\n', 'missing_field'],
    ['unterminated entry metadata', '\n---\n```entry\ncreated: 2026-10-31T10:00\n', 'unterminated_entry_block'],
  ])('marks corpus and the loaded weekly records incomplete after %s', (_label, broken, code) => {
    writeFileSync(join(root, weekly), weekHeader + validEntry + broken);
    store.rebuild();
    expect(store.getEntries()).toHaveLength(1);
    expect(store.getSourceHealth().issue?.code).toBe(code);
    expect(store.getRecordSourceHealth('entry', created).issue?.code).toBe(code);
    expect(store.getRecordSourceHealth('action', action).complete).toBe(true);
  });

  it('fences all scopes on failed owner rebuild and recovers on the next publication', () => {
    const previous = store.getSourceHealth();
    store.recordRebuildFailure(new Error('Injected publication failure'));
    expect(store.getSourceHealth().issue?.code).toBe('rebuild_failed');
    expect(store.getManifestSourceHealth().complete).toBe(false);
    expect(store.getRecordSourceHealth('action', action).complete).toBe(false);
    expect(previous.complete).toBe(true);
    store.rebuild();
    expect(store.getSourceHealth().complete).toBe(true);
    expect(store.getManifestSourceHealth().complete).toBe(true);
    expect(store.getRecordSourceHealth('action', action).complete).toBe(true);
  });

  it('never certifies source health when a durable record update cannot publish its graph', () => {
    vi.spyOn(DataCore.prototype, 'deriveRelations').mockImplementationOnce(() => {throw new Error('Injected graph failure');});
    const before = store.getAction(action)!;
    expect(() => store.saveAction(action, {...before.frontMatter, name: 'Durable update'}, before.body, store.getActionFile(action)!)).toThrow('Injected graph failure');
    expect(store.getAction(action)?.frontMatter.name).toBe('Durable update');
    expect(store.getSourceHealth().complete).toBe(false);
    expect(store.getManifestSourceHealth().complete).toBe(false);
    expect(store.getRecordSourceHealth('action', action).complete).toBe(false);
    store.rebuild();
    expect(store.getSourceHealth().complete).toBe(true);
    expect(store.getAction(action)?.frontMatter.name).toBe('Durable update');
  });

  it('keeps domain diagnostics separate from structural completeness', () => {
    writeFileSync(store.getActionFile(action)!, '---\nname: Action\ncreated: 2026-10-31\ndelegation: {unexpected: true}\n---\nAction body.\n');
    store.rebuild();
    expect(store.getSourceHealth().complete).toBe(true);
    const health = store.getRecordSourceHealth('action', action);
    expect(health.complete).toBe(true);
    expect(health.issues.some(issue => issue.code === 'invalid_delegation')).toBe(true);
  });
});

describe('source diagnostic association', () => {
  it.skipIf(process.platform === 'win32')('preserves literal backslashes in POSIX instance paths', () => {
    const root = '/instance\\literal';
    const file = join(root, 'actions', '2026', `${action}.md`);
    const issue = {severity: 'error' as const, code: 'invalid_yaml', file: `actions/2026/${action}.md`, message: 'Malformed action'};
    const published = sourceHealthPublication(root, [issue], {notes: new Map(), projects: new Map(), artifacts: new Map(),
      actions: new Map([[action, file]])});
    expect(published.recordIssues.action.get(action)).toEqual([issue]);
    expect(published.records.action.get(action)?.issue).toBe(issue);
  });

  it('classifies a weekly source once and shares its health across all loaded entries', () => {
    const file = '/instance/notes/2026/2026-10-26.md';
    let classifications = 0;
    const issues = Array.from({length: 150}, () => ({
      severity: 'error' as const, get code() {classifications++; return 'invalid_yaml';}, file,
      message: 'Malformed entry metadata',
    }));
    const entries = Array.from({length: 600}, (_, index) => [`entry-${index}`, file] as const);
    const published = sourceHealthPublication('/instance', issues, {notes: new Map(entries),
      projects: new Map(), actions: new Map(), artifacts: new Map()});
    const health = published.records.entry.get(entries[0][0])!;
    const diagnostics = published.recordIssues.entry.get(entries[0][0]);
    expect(health.complete).toBe(false);
    for (const [id] of entries) {
      expect(published.records.entry.get(id)).toBe(health);
      expect(published.recordIssues.entry.get(id)).toBe(diagnostics);
    }
    // This bound grows with source diagnostics, independently of entry count.
    // It catches reclassification for every entry without a flaky clock limit.
    expect(classifications).toBeLessThan(issues.length * 20);
  });

  it('groups ancestor, absolute/relative and identity-prefixed issues once for consumers', () => {
    const root = '/instance';
    const issues = [
      {severity: 'error' as const, code: 'read_error', file: 'actions/2026', message: 'Directory unavailable'},
      {severity: 'error' as const, code: 'invalid_occurrence', file: `/instance/actions/2026/${action}.md`, message: 'Invalid occurrence'},
      {severity: 'error' as const, code: 'invalid_recurrence_relationship', message: `${action}: Invalid relationship`},
    ];
    const published = sourceHealthPublication(root, issues, {notes: new Map(), projects: new Map(),
      actions: new Map([[action, `/instance/actions/2026/${action}.md`]]), artifacts: new Map()});
    expect(published.records.action.get(action)?.issue?.message).toBe('Directory unavailable');
    expect(published.recordIssues.action.get(action)).toEqual(issues);
  });

  it('separates primary source parse diagnostics from derived artifact graph and attachment issues', () => {
    const file = `/instance/artifacts/2026/${artifact}.md`;
    const issues = [
      {severity: 'error' as const, code: 'missing_field', file, field: 'name', message: 'Missing name'},
      {severity: 'error' as const, code: 'artifact_reference_missing', file, message: 'Missing reference'},
      {severity: 'error' as const, code: 'artifact_attachment_read_error', file, message: 'Unreadable attachment'},
    ];
    const published = sourceHealthPublication('/instance', issues, {notes: new Map(), projects: new Map(), actions: new Map(), artifacts: new Map([[artifact, file]])});
    expect(published.records.artifact.get(artifact)?.issues).toEqual([issues[0]]);
    expect(published.recordIssues.artifact.get(artifact)).toEqual(issues);
  });

  it('does not associate action relationship diagnostics with another entity that shares its id', () => {
    const issue = {severity: 'error' as const, code: 'invalid_recurrence_relationship', message: `${action}: Invalid relationship`};
    const published = sourceHealthPublication('/instance', [issue], {notes: new Map(), projects: new Map(),
      actions: new Map([[action, `/instance/actions/2026/${action}.md`]]),
      artifacts: new Map([[action, `/instance/artifacts/2026/${action}.md`]])});
    expect(published.recordIssues.action.get(action)).toEqual([issue]);
    expect(published.recordIssues.artifact.get(action)).toEqual([]);
  });

  it('retains action-specific relationship health when different identities share a file', () => {
    const other = '2026-10-31-other', file = `/instance/actions/2026/${action}.md`;
    const issue = {severity: 'error' as const, code: 'invalid_recurrence_relationship', message: `${action}: Invalid relationship`};
    const published = sourceHealthPublication('/instance', [issue], {notes: new Map(), projects: new Map(), artifacts: new Map(),
      actions: new Map([[action, file], [other, file]])});
    expect(published.recordIssues.action.get(action)).toEqual([issue]);
    expect(published.recordIssues.action.get(other)).toEqual([]);
    expect(published.records.action.get(action)?.issues).toEqual([issue]);
    expect(published.records.action.get(other)?.issues).toEqual([]);
  });
});

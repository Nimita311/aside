import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { marked, type Token, type Tokens } from 'marked';
import { describe, expect, it } from 'vitest';
import { FIXTURE_NAMES, loadFixture, SHOWCASE_IDS } from '../fixture-store';

describe('gallery fixture data', () => {
  it('parses the showcase using the real core, with linked records and a complete search index', async () => {
    const { snapshot, store } = await loadFixture('showcase');
    expect(snapshot.instance?.manifest.id).toBe('showcase');
    expect(snapshot.diagnostics).toEqual([]);
    expect(snapshot.searchProgress.complete).toBe(true);
    expect(snapshot.indexes.projects.length).toBeGreaterThanOrEqual(3);
    expect(snapshot.indexes.actions.length).toBeGreaterThanOrEqual(6);
    expect(snapshot.indexes.artifacts.map(item => item.id)).toEqual(expect.arrayContaining([
      SHOWCASE_IDS.typography, SHOWCASE_IDS.diagrams, SHOWCASE_IDS.media, SHOWCASE_IDS.dashboard,
    ]));
    expect(snapshot.weeks.flatMap(([, entries]) => entries).some(entry => entry.meta.created === SHOWCASE_IDS.entry)).toBe(true);
    const relations = await store.getRelations();
    expect(relations.entriesByEntity.get(`#project/${SHOWCASE_IDS.project}`)?.length).toBeGreaterThan(0);
    expect(relations.actionsByProject.get(SHOWCASE_IDS.project)?.length).toBeGreaterThan(0);
    const actions = snapshot.actions.map(([, action]) => action.frontMatter);
    expect(actions.some(action => action.scheduled)).toBe(true);
    expect(actions.some(action => action.deadline)).toBe(true);
    expect(actions.some(action => action.recurrence?.length)).toBe(true);
    expect(actions.some(action => action.resolution === 'done')).toBe(true);
    expect(actions.some(action => action.resolution === 'cancelled')).toBe(true);
  });

  it('has distinct empty and malformed data worlds rather than changing rendered output', async () => {
    expect(FIXTURE_NAMES).toEqual(['showcase', 'empty', 'malformed']);
    const empty = await loadFixture('empty');
    expect(empty.snapshot.instance?.manifest.id).toBe('empty');
    expect(empty.snapshot.weeks).toEqual([]);
    for (const index of Object.values(empty.snapshot.indexes)) expect(index).toEqual([]);
    expect(empty.snapshot.diagnostics).toEqual([]);
    const malformed = await loadFixture('malformed');
    expect(malformed.snapshot.instance?.manifest.id).toBe('malformed');
    expect(malformed.snapshot.diagnostics.length).toBeGreaterThan(0);
    expect(malformed.snapshot.searchProgress.complete).toBe(false);
  });

  it('includes real Markdown typography specimens and Mermaid sources', async () => {
    const { snapshot } = await loadFixture('showcase');
    const artifacts = new Map(snapshot.artifacts);
    const typography = artifacts.get(SHOWCASE_IDS.typography)!;
    const tokens = marked.lexer(typography.body);
    const all: Token[] = [];
    marked.walkTokens(tokens, token => { all.push(token); });
    expect(all.filter((token): token is Tokens.Heading => token.type === 'heading').map(token => token.depth))
      .toEqual(expect.arrayContaining([1, 2, 3, 4, 5, 6]));
    const types = new Set(all.map(token => token.type));
    for (const type of ['paragraph', 'strong', 'em', 'del', 'codespan', 'code', 'blockquote', 'list', 'table', 'link', 'hr']) {
      expect(types.has(type), `${type} appears in the typography specimen`).toBe(true);
    }
    const lists = all.filter((token): token is Tokens.List => token.type === 'list');
    expect(lists.some(list => list.ordered)).toBe(true);
    expect(lists.some(list => list.items.some(item => item.task))).toBe(true);
    const diagrams = marked.lexer(artifacts.get(SHOWCASE_IDS.diagrams)!.body)
      .filter((token): token is Tokens.Code => token.type === 'code' && token.lang === 'mermaid')
      .map(token => token.text).join('\n');
    for (const syntax of [
      'flowchart', 'sequenceDiagram', 'stateDiagram-v2', 'classDiagram', 'erDiagram',
      'mindmap', 'gantt', 'pie', 'journey', 'timeline', 'gitGraph', 'quadrantChart',
      'xychart-beta', 'sankey-beta', 'requirementDiagram', 'block-beta', '$$',
    ]) {
      expect(diagrams, `${syntax} has an editable Mermaid source`).toContain(syntax);
    }
  });

  it('ships attachment bytes locally, including a dashboard that calls the SDK', async () => {
    const { root, files, snapshot } = await loadFixture('showcase');
    const attachments = snapshot.artifacts.flatMap(([id, artifact]) => (artifact.frontMatter.attachments ?? [])
      .map(filename => `artifacts/${id.slice(0, 4)}/${id}/${filename}`));
    expect(attachments.length).toBeGreaterThanOrEqual(6);
    for (const file of attachments) {
      expect(files, `indexed attachment ${file} exists`).toContain(file);
      expect((await readFile(resolve(root, file))).byteLength, file).toBeGreaterThan(0);
    }
    for (const extension of ['.pdf', '.svg', '.wav', '.mp4', '.html', '.txt']) {
      expect(files.some(file => file.endsWith(extension)), `local ${extension} reader specimen`).toBe(true);
    }
    const dashboardFiles = files.filter(file => file.startsWith(`artifacts/2026/${SHOWCASE_IDS.dashboard}/`));
    const dashboard = (await Promise.all(dashboardFiles.filter(file => /\.(js|html)$/.test(file))
      .map(file => readFile(resolve(root, file), 'utf8')))).join('\n');
    expect(dashboard).toContain('aside.query');
    expect(dashboard).not.toMatch(/https?:\/\/[^\s"']+\.(?:js|css)/);
  });
});

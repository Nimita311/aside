import { mkdtempSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/mcp/store.js';
import { RegexWorkerPool } from '../src/mcp/search.js';
import { writeFixture } from '../bench/fixture.js';
import { backendCaller } from '../bench/backend.js';
import { CASES, Context, QueryLimitError } from '../bench/cases.js';

describe('canonical query benchmark correctness', () => {
  it.each([
    { size: 40, fanout: 1, bodyBytes: 0 }, { size: 100, fanout: 1, bodyBytes: 0 }, { size: 301, fanout: 1, bodyBytes: 0 },
    { size: 40, fanout: 8, bodyBytes: 0 }, { size: 301, fanout: 8, bodyBytes: 0 }, { size: 100, fanout: 1, bodyBytes: 4096 },
  ])('returns complete equivalent answers at $size entries, fanout $fanout, body bytes $bodyBytes', async ({ size, fanout, bodyBytes }) => {
    const dir = mkdtempSync('/tmp/aside-query-bench-test-');
    const fixture = writeFixture(dir, size, { fanout, bodyBytes });
    const store = new Store(dir);
    const pool = new RegexWorkerPool({ workerUrl: new URL('../dist/regex-worker.js', import.meta.url) });
    try {
      expect(store.getIssues()).toEqual([]);
      expect(store.getEntries()).toHaveLength(size);
      const call = backendCaller(store, pool);
      for (const task of CASES) {
        // Exercise the first query after a record rewrite and graph rebuild.
        await call('update_project', { id: fixture.focus, name: fixture.projects.find(p => p.id === fixture.focus)!.name });
        const expected = task.expected(fixture);
        const graph = new Context(call, 5), legacy = new Context(call, 5);
        expect(await task.graphql(graph, fixture), `${task.id}: GraphQL answer`).toEqual(expected);
        expect(await task.legacy(legacy, fixture), `${task.id}: legacy answer`).toEqual(expected);
        expect(graph.metrics.requestBytes).toBeGreaterThan(0);
        expect(graph.metrics.responseBytes).toBeGreaterThan(graph.metrics.responseTextBytes);
        expect(legacy.metrics.calls).toBeGreaterThanOrEqual(legacy.metrics.rounds);
        if (task.id === 'project-catch-up') {
          expect(graph.metrics.calls).toBe(1);
          expect(legacy.metrics.calls).toBeGreaterThan(1);
          const answer = expected as { entries: { content: string }[]; related: unknown[] };
          if (fanout === 1) expect(answer.entries[0].content).toContain('Mention #project/');
          expect(answer.related).toHaveLength(2);
        }
        if (task.id === 'artifacts-via-project-work') {
          const direct = CASES.find(c => c.id === 'artifacts-for-unfinished-actions')!.expected(fixture) as unknown[];
          expect((expected as unknown[]).length).toBeGreaterThan(direct.length);
        }
      }
    } finally { store.close(); await pool.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it('never interprets an empty join input as the legacy unassociated filter', async () => {
    const fixture = writeFixtureShape();
    const ctx = new Context(async () => ({ content: [{ type: 'text', text: '0 of 0\noffset: 0\nlimit: 100\nnext_offset: null\n\n' }] }), 100);
    expect(await CASES.find(c => c.id === 'artifacts-for-unfinished-actions')!.legacy(ctx, fixture)).toEqual([]);
    expect(ctx.metrics.calls).toBe(1);
  });

  it('distinguishes known query limits from errors that must abort a benchmark', async () => {
    const raw = new Context(async () => { throw new Error('Regex search snapshot is too large. Narrow the query.'); }, 100);
    await expect(raw.call('query_entries', {}, 1)).rejects.toBeInstanceOf(QueryLimitError);
    const graph = new Context(async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ errors: [{ message: 'GraphQL query work limit exceeded.' }] }) }] }), 100);
    await expect(graph.graph('{ entries { nodes { id } } }', {})).rejects.toBeInstanceOf(QueryLimitError);
    const mixed = new Context(async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ errors: [
      { message: 'GraphQL query work limit exceeded.' }, { message: 'first must be from 1 to 100.' },
    ] }) }] }), 100);
    await expect(mixed.graph('{ entries { nodes { id } } }', {})).rejects.not.toBeInstanceOf(QueryLimitError);
    const diagnostics = new Context(async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({
      errors: [{ message: 'GraphQL query work limit exceeded.' }], extensions: { complete: false },
    }) }] }), 100);
    await expect(diagnostics.graph('{ entries { nodes { id } } }', {})).rejects.not.toBeInstanceOf(QueryLimitError);
    const tokens = new Context(async () => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({
      errors: [{ message: 'Syntax Error: Document contains more than 5000 tokens. Parsing aborted.' }],
    }) }] }), 100);
    await expect(tokens.graph('{ entries { totalCount } }', {})).rejects.toBeInstanceOf(QueryLimitError);
    const unexpected = new Context(async () => { throw new Error('Wrong relationship answer'); }, 100);
    await expect(unexpected.call('query_entries', {}, 1)).rejects.not.toBeInstanceOf(QueryLimitError);
    const partial = new Context(async () => ({ content: [{ type: 'text', text: '{"data":{},"extensions":{"complete":false}}' }] }), 100);
    await expect(partial.graph('{ entries { totalCount } }', {})).rejects.not.toBeInstanceOf(QueryLimitError);
  });
});

function writeFixtureShape(): ReturnType<typeof writeFixture> {
  return { projects: [], actions: [], artifacts: [], entries: [], focus: '', projectActions: new Map(), actionProjects: new Map(),
    projectEntries: new Map(), artifactProjects: new Map(), artifactActions: new Map() };
}

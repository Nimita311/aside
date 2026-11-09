import { describe, expect, it } from 'vitest';
import { chunkDocument, type SearchDocument } from '../src/semantic/documents.js';

const document = (content: string, extra: Partial<SearchDocument> = {}): SearchDocument => ({
  kind: 'project', id: 'research', handle: '#project/research', name: 'Research',
  description: 'Research notes', created: '2026-10-28', projects: [], content, ...extra,
});

describe('bounded semantic passages', () => {
  it('bounds repeated context for a pathological long heading without losing its ending', () => {
    const chunks = chunkDocument(document(`# ${'界'.repeat(33_000)}\nA final source sentence.`));
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunks.every(chunk => chunk.snippet.length <= 1400)).toBe(true);
    expect(chunks.every(chunk => chunk.text.length <= 3402)).toBe(true);
    expect(chunks.at(-1)!.snippet).toContain('A final source sentence.');
    expect(chunks.slice(1).every(chunk => chunk.snippet.startsWith(`# ${'界'.repeat(198)}\n`))).toBe(true);
  });

  it('retains normal heading context and exact body overlap inside the passage budget', () => {
    const heading = '# Research';
    const chunks = chunkDocument(document(`${heading}\n${'alpha beta gamma delta '.repeat(500)}`));
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks[0].snippet.startsWith(`${heading}\n`)).toBe(true);
    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index].snippet.startsWith(`${heading}\n`)).toBe(true);
      expect(chunks[index].snippet.slice(heading.length + 1, heading.length + 161)).toBe(chunks[index - 1].snippet.slice(-160));
      expect(chunks[index].snippet.length).toBeLessThanOrEqual(1400);
    }
  });

  it('keeps headings inside fences together, including shorter fence-like lines', () => {
    const chunks = chunkDocument(document('# First\n~~~~text\n# Inside\n~~~\n# Still inside\n~~~~\n# Second\nOutside.'));
    expect(chunks).toHaveLength(2);
    expect(chunks[0].snippet).toContain('# Inside\n~~~\n# Still inside');
    expect(chunks[1].snippet).toBe('# Second\nOutside.');
  });

  it('bounds a metadata-only passage as well as ordinary body passages', () => {
    const chunks = chunkDocument(document('   ', { name: '界'.repeat(3000), description: 'A long metadata-only record' }));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].snippet.length).toBeLessThanOrEqual(1400);
    expect(chunks[0].text.length).toBeLessThanOrEqual(3402);
  });
});

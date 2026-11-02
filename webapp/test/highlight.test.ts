import { describe, it, expect } from 'vitest';
import { highlight } from '../src/search';

describe('highlight', () => {
  it('escapes text and marks matches', () => {
    expect(highlight('a & b', 'b')).toBe('a &amp; <mark>b</mark>');
  });

  it('does not tear escaped entities when the query matches entity text', () => {
    // "amp" appears in the escaped form of "&" but not in the raw text.
    expect(highlight('Fix < & deploy', 'amp')).toBe('Fix &lt; &amp; deploy');
  });

  it('escapes HTML inside the matched text itself', () => {
    expect(highlight('x<y', '<')).toBe('x<mark>&lt;</mark>y');
  });

  it('returns escaped text unmarked for an empty query', () => {
    expect(highlight('a<b & c', '  ')).toBe('a&lt;b &amp; c');
  });

  it('marks every term of a term list', () => {
    expect(highlight('cascade blog post', ['cascade', 'post']))
      .toBe('<mark>cascade</mark> blog <mark>post</mark>');
  });

  it('prefers the longer term when terms overlap', () => {
    expect(highlight('cascades', ['cascades', 'cade'])).toBe('<mark>cascades</mark>');
  });

  it('returns escaped text unmarked for an empty term list', () => {
    expect(highlight('a<b', [])).toBe('a&lt;b');
  });
});

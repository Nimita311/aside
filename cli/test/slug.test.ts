import { describe, it, expect } from 'vitest';
import { toKebabCase } from '../src/core/slug.js';

describe('toKebabCase (i18n slug rule)', () => {
  it('folds compatibility forms and collapses filesystem-unsafe runs', () => {
    // An id is an identifier: presentation-only variants fold so a name typed in any
    // form converges (NFKC — see toKebabCase). Faithfulness lives in the `name` field.
    expect(toKebabCase('Ｑ３')).toBe('q3');                // fullwidth -> ASCII (CJK IME)
    expect(toKebabCase('ﬁle')).toBe('file');              // ligature -> fi
    expect(toKebabCase('½ off')).toBe('1-2-off');         // vulgar fraction
    expect(toKebabCase('Ⅻ Legion')).toBe('xii-legion');   // Roman numeral
    expect(toKebabCase('① First')).toBe('1-first');       // circled number
    expect(toKebabCase('🎉 Party')).toBe('party');         // emoji isn't a usable filename char
    expect(toKebabCase('C++ & Rust')).toBe('c-rust');     // unsafe symbol runs -> one dash
  });

  it('keeps mixed ASCII + CJK, turning spaces into dashes', () => {
    expect(toKebabCase('Q3 報告')).toBe('q3-報告');
  });

  it('preserves single-word names in every script as their NFKC-lowercased form', () => {
    // Letters, digits AND combining marks survive, so a word is never fragmented.
    const words = ['สวัสดี', 'नमस्ते', 'مَرحَبًا', 'שָׁלוֹם', 'Привет', 'Καλημέρα', '项目报告', '会議メモ', '회의록', 'Việt'];
    for (const w of words) {
      expect(toKebabCase(w)).toBe(w.normalize('NFKC').toLowerCase());
    }
  });

  it('does not fragment scripts that carry vowels/diacritics as combining marks', () => {
    for (const w of ['สวัสดี', 'नमस्ते', 'مَرحَبًا', 'שָׁלוֹם']) {
      expect(toKebabCase(w).includes('-')).toBe(false);
    }
  });

  it('folds case, canonical normalization, and compatibility variants to one ID', () => {
    const nfc = 'café';        // precomposed e-acute (NFC)
    const nfd = 'café';       // e + combining acute (NFD)
    expect(nfc).not.toBe(nfd);                              // different code units
    expect(toKebabCase(nfc)).toBe(toKebabCase(nfd));        // canonical normalization
    expect(toKebabCase('ROAD MAP')).toBe(toKebabCase('road map'));  // case
    expect(toKebabCase('ﬁle')).toBe(toKebabCase('file'));   // compatibility (ligature)
  });

  it('caps the slug to a filesystem-safe byte length without splitting characters', () => {
    const long = 'あ'.repeat(100);                          // 300 bytes (3 bytes/char)
    const slug = toKebabCase(long);
    expect(Buffer.byteLength(slug, 'utf8')).toBeLessThanOrEqual(200);
    expect(slug.endsWith('-')).toBe(false);
    expect(long.normalize('NFKC').toLowerCase().startsWith(slug)).toBe(true);  // clean prefix
  });

  it('rejects names with no letter or digit (marks alone do not count)', () => {
    // A combining mark needs a base, so a mark-only name yields no meaningful id.
    for (const bad of ['!!!', '🎉🚀', '   ', '', '/\\:*?', '́́́', 'ั']) {
      expect(() => toKebabCase(bad)).toThrow('Cannot derive ID from name');
    }
  });

  it('drops a leading combining mark that has no base to attach to', () => {
    expect(toKebabCase('́abc')).toBe('abc');
  });
});

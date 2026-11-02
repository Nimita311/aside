import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Guardrail for the type-scale pairing invariant declared at the token block
// in style.css: line-height tokens are whole pixels, and every font-size
// above the base carries its paired line-height.

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'style.css'), 'utf8');

// Rule blocks: everything between { and }. Nested @media braces are handled
// by taking the text after the last { — that is always a declaration list.
function blocks(): { selector: string; decls: string }[] {
  const out: { selector: string; decls: string }[] = [];
  for (const chunk of css.split('}')) {
    const open = chunk.lastIndexOf('{');
    if (open === -1) continue;
    out.push({
      selector: chunk.slice(0, open).trim().split('\n').pop()!.trim(),
      decls: chunk.slice(open + 1),
    });
  }
  return out;
}

const BASE_PX = 14;

// A font-size that can exceed the base — and therefore exceed an inherited
// paired line-height — from its declaration alone.
function isAboveBase(value: string): boolean {
  const px = value.match(/^(\d+(?:\.\d+)?)px$/);
  if (px) return parseFloat(px[1]) > BASE_PX;
  const em = value.match(/^(\d+(?:\.\d+)?)em$/);
  if (em) return parseFloat(em[1]) > 1;
  return /var\(--font-size-(md|lg|xl)\)/.test(value);
}

describe('type scale pairing', () => {
  it('declares every --line-height-* token as whole pixels', () => {
    const tokens = [...css.matchAll(/--line-height-\w+:\s*([^;]+);/g)];
    expect(tokens.length).toBeGreaterThan(0);
    for (const [decl, value] of tokens) {
      expect(value.trim(), decl).toMatch(/^\d+px$/);
    }
  });

  it('pairs a line-height with every font-size above the base', () => {
    const unpaired = blocks()
      .filter(({ decls }) => {
        const fs = decls.match(/font-size:\s*([^;]+);/);
        return fs && isAboveBase(fs[1].trim()) && !/line-height:/.test(decls);
      })
      .map(({ selector }) => selector);
    expect(unpaired, 'blocks setting font-size above the base without the paired line-height').toEqual([]);
  });

  it('keeps unitless line-heights integral against their block font-size', () => {
    const offenders: string[] = [];
    for (const { selector, decls } of blocks()) {
      const lh = decls.match(/line-height:\s*(\d+(?:\.\d+)?)\s*;/);
      if (!lh) continue;
      const fs = decls.match(/font-size:\s*(\d+(?:\.\d+)?)px/);
      if (!fs) continue; // ratio against an inherited size — not checkable here
      const product = parseFloat(lh[1]) * parseFloat(fs[1]);
      if (Math.abs(product - Math.round(product)) > 1e-6) {
        offenders.push(`${selector} → ${fs[1]}px × ${lh[1]} = ${product}px`);
      }
    }
    expect(offenders, 'unitless line-heights must land on whole pixels').toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { errorLine } from '../src/commands/output.js';

describe('errorLine', () => {
  it('prints ordinary messages verbatim', () => {
    expect(errorLine(new Error('Instance "work" is unavailable.'))).toBe('Error: Instance "work" is unavailable.');
    expect(errorLine('plain')).toBe('Error: plain');
  });

  it('keeps multi-line recovery messages readable', () => {
    expect(errorLine(new Error('Cannot stop.\nInstances in use:\n\t/tmp/alpha'))).toBe('Error: Cannot stop.\nInstances in use:\n\t/tmp/alpha');
  });

  it('escapes terminal control sequences from record-derived text', () => {
    const line = errorLine(new Error('Instances:\n  \u001b]0;pwned\u0007\u001b[2J\r: /tmp/x'));
    expect(line).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(line).toBe('Error: Instances:\n  \\u001b]0;pwned\\u0007\\u001b[2J\\u000d: /tmp/x');
  });
});

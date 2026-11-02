import { describe, expect, it } from 'vitest';
import { withoutCode } from '../src/core/markdown.js';

describe('Markdown code masking', () => {
  const handle = '#project/2026-10-10-example';

  it.each([
    `Discussed work:\n    ${handle}`,
    `Discussed work:\n\t${handle}`,
    `> Discussed work:\n>     ${handle}`,
    `> Discussed work:\n    ${handle}`,
    `- Discussed work:\n      ${handle}`,
  ])('keeps indented paragraph continuations as prose: %s', markdown => {
    expect(withoutCode(markdown)).toBe(markdown);
  });

  it.each([
    `    ${handle}`,
    `Discussed work:\n\n    ${handle}`,
    `# Heading\n    ${handle}`,
    `- - -\n    ${handle}`,
    `- Discussed work:\n\n      ${handle}`,
    `\`\`\`\nexample\n\`\`\`\n    ${handle}`,
  ])('still masks actual indented code blocks: %s', markdown => {
    const masked = withoutCode(markdown);
    expect(masked).not.toContain(handle);
    expect(masked.length).toBe(markdown.length);
    expect(masked.split('\n').length).toBe(markdown.split('\n').length);
  });

  it.each([
    `First unmatched \`\n\n${handle}\n\nLater unmatched \``,
    `First unmatched \`\n \t\n${handle}\n\nLater unmatched \``,
    `> First unmatched \`\n>\n> ${handle}\n>\n> Later unmatched \``,
    `First unmatched \`\n# ${handle} \``,
    `- First unmatched \`\n- ${handle} \``,
  ])('never pairs inline delimiters across Markdown blocks: %s', markdown => {
    expect(withoutCode(markdown)).toBe(markdown);
  });

  it.each([
    `Read \`\n${handle}\n\` as a literal.`,
    `> Read \`\n> ${handle}\n> \` as a literal.`,
    `> Read \`\n${handle}\n\` as a literal.`,
    `- Read \`\n  ${handle}\n  \` as a literal.`,
  ])('masks multiline inline code within a paragraph: %s', markdown => {
    const masked = withoutCode(markdown);
    expect(masked).not.toContain(handle);
    expect(masked.length).toBe(markdown.length);
    expect(masked.split('\n').length).toBe(markdown.split('\n').length);
  });
});

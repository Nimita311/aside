import { ENTRY_PREAMBLE, splitFrontMatter } from '../../core/parser.js';
import { parseDocument } from 'yaml';
import { formatScalar } from '../format.js';
import { mergeMetadata } from './front-matter.js';

// Reject the one sequence entry content cannot hold: a `---` line followed by a
// ```entry fence is the entry preamble, so embedding it would split the note into
// a phantom entry. Fail loud, before any writes, rather than silently corrupting
// the paper trail. (A bare `---` rule on its own is fine.)
export function validateEntryContent(content: string): void {
  if (ENTRY_PREAMBLE.test(content)) {
    throw new Error(
      'Entry content cannot contain a line "---" immediately followed by a ```entry fence — ' +
      'that two-line sequence is the entry preamble and would be parsed as the start of a new entry.\n' +
      'Hint: keep the "---" and the ```entry fence from being adjacent, then try again. ' +
      'Use a different horizontal rule (*** or ___), indent the example by four spaces, ' +
      'or put a line of text between them. A bare "---" rule on its own is fine.',
    );
  }
}

function entryScalar(value: string): string {
  const escaped = formatScalar(value);
  // The metadata fence parser stops at a literal triple-backtick anywhere in
  // its block, even inside a quoted YAML value. Escape backticks in such IDs.
  if (value.includes('```')) return (escaped !== value ? escaped : JSON.stringify(value)).replace(/`/g, '\\u0060');
  if (escaped !== value) return escaped;
  // Keep canonical IDs/timestamps bare, but verify the flow-list context too:
  // punctuation in a hand-edited ID must not create another list item or map.
  try {
    const doc = parseDocument(`[${value}]`);
    if (doc.errors.length === 0 && doc.warnings.length === 0) {
      const parsed: unknown = doc.toJS();
      if (Array.isArray(parsed) && parsed.length === 1 && parsed[0] === value) return value;
    }
  } catch { /* quote values that cannot be used verbatim */ }
  return JSON.stringify(value);
}

// Build one entry's bare block: the ```entry metadata fence followed by content.
// Empty link lists are omitted so the block carries only what's set.
export function buildEntryBlock(
  created: string,
  projectIds: string[],
  actionIds: string[],
  content: string,
  originalMetadata?: string,
  fields: readonly string[] = ['created', 'projects', 'actions'],
): string {
  let metaLines = `created: ${entryScalar(created)}`;
  if (projectIds.length > 0) {
    metaLines += `\nprojects: [${projectIds.map(entryScalar).join(', ')}]`;
  }
  if (actionIds.length > 0) {
    metaLines += `\nactions: [${actionIds.map(entryScalar).join(', ')}]`;
  }
  if (originalMetadata !== undefined) {
    metaLines = mergeMetadata(originalMetadata, metaLines, fields, `entry ${created}`, true);
  }
  return `\`\`\`entry\n${metaLines}${metaLines.endsWith('\n') ? '' : '\n'}\`\`\`\n\n${content}`;
}

// Render bare entry blocks into a weekly-file body. Per the note spec (design/note.md),
// every entry begins with a `---` preamble directly
// attached to its ```entry fence (no blank line between), and consecutive entries are
// separated by one blank line before the preamble (`content\n\n---\n```entry`).
// Each block is trimmed so empty or trailing-whitespace content can't open a gap.
export function renderEntries(blocks: string[]): string {
  return blocks.map((b) => `---\n${b.trim()}`).join('\n\n');
}

// Split a weekly-file body into bare entry segments — the inverse of renderEntries.
// Uses the shared ENTRY_PREAMBLE (a `---` line followed by a ```entry fence), so a
// bare `---` inside entry content is preserved rather than treated as a boundary.
// Trimming each segment also tolerates the legacy padded-separator format and a
// missing leading preamble, so re-rendering an older file self-heals it.
export function splitEntrySegments(body: string): string[] {
  return body
    .split(ENTRY_PREAMBLE)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Split a weekly file into its front-matter block (fences included) and the body
// after it; null when there's no recognizable front matter (an *empty* block is
// still front matter). Delegates to the shared core splitter so the MCP and the
// parsers agree on where front matter ends; the fences are re-attached with
// canonical trailing whitespace, in the block's own line-ending style, so a
// rewrite self-heals stray whitespace without re-writing a CRLF block's fences
// as LF (rendered entry separators are LF regardless).
export function splitWeekFile(content: string): { frontMatter: string; body: string } | null {
  const { yaml, body, present } = splitFrontMatter(content);
  if (!present) return null;
  const eol = /^---[ \t]*\r\n/.test(content.replace(/^\uFEFF/, '').trimStart()) ? '\r\n' : '\n';
  const yamlLf = yaml.replace(/\r(?=\n|$)/g, '');
  const frontMatter = ['---', ...yamlLf.split('\n'), '---', ''].join(eol);
  return { frontMatter, body };
}

// Split a document into its YAML front matter and body. The single front-matter
// splitter — the parsers here, the validator's style lints, and the MCP's
// splitWeekFile all use it, so they can never disagree about where front matter
// ends. Two deliberate choices:
// - A fence line is exactly `---` with optional trailing spaces/tabs/CR
//   ([ \t\r]*, not \s*), so a `----` rule or a `--- draft` line inside a block
//   scalar never terminates the front matter early.
// - A leading BOM and leading whitespace before the opening fence are tolerated,
//   matching isAsideDir's `trimStart()` intent — a file it accepts also parses.
export function splitFrontMatter(content: string): { yaml: string; body: string; present: boolean } {
  const stripped = content.replace(/^\uFEFF/, '').trimStart();
  const match = stripped.match(/^---[ \t\r]*\n(?:([\s\S]*?)\r?\n)?---[ \t\r]*(?:\n([\s\S]*))?$/);
  if (!match) return { yaml: '', body: content, present: false };
  return { yaml: match[1] ?? '', body: match[2] ?? '', present: true };
}

// Keep newlines and positions while masking Markdown code. Fence lengths and
// inline backtick lengths must match, so code examples never establish links.
export function withoutCode(markdown: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  let fence: { marker: string; length: number; quote: number; listIndent: number } | undefined;
  let listIndent = 0;
  let listQuote = 0;
  let paragraph = false;
  let paragraphQuote = 0;
  let offset = 0;
  const boundaries = new Set<number>([0]);
  const htmlMasked = markdown.replace(/(?<!\\)<(pre|code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, blank);
  const lines = htmlMasked.split('\n').map(line => {
    const start = offset;
    offset += line.length + 1;
    const quotePrefix = line.match(/^(?: {0,3}>[ \t]?)+/)?.[0] ?? '';
    const quote = (quotePrefix.match(/>/g) ?? []).length;
    const unquoted = line.slice(quotePrefix.length);
    const listPrefix = unquoted.match(/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/)?.[0] ?? '';
    const leading = unquoted.match(/^ */)?.[0].length ?? 0;
    // New containers start their own inline blocks. An indented continuation
    // of an existing paragraph remains prose: indented code cannot interrupt it.
    if (listPrefix || quote > paragraphQuote || (quote < paragraphQuote && !paragraph)) {
      paragraph = false; boundaries.add(start);
    }
    paragraphQuote = quote;
    // A fence inside a quote or list ends with that container, even when no
    // closing delimiter was written. The following prose still supplies links.
    if (fence && (quote < fence.quote || (fence.listIndent && unquoted.trim() && leading < fence.listIndent))) {
      fence = undefined;
    }
    if (!fence) {
      if (quote !== listQuote) listIndent = 0;
      listQuote = quote;
      if (listPrefix) listIndent = listPrefix.length;
      else if (unquoted.trim() && leading < listIndent) listIndent = 0;
    }
    const container = unquoted.slice(listPrefix.length || (leading >= listIndent ? listIndent : 0));
    const match = container.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (match && match[1][0] === fence.marker && match[1].length >= fence.length && !match[2].trim()) fence = undefined;
      paragraph = false; boundaries.add(start); boundaries.add(offset);
      return blank(line);
    }
    if (match) {
      fence = { marker: match[1][0], length: match[1].length, quote, listIndent };
      paragraph = false; boundaries.add(start); boundaries.add(offset);
      return blank(line);
    }
    if (!container.trim()) {
      paragraph = false; boundaries.add(start); boundaries.add(offset);
      return line;
    }
    if (/^(?: {4}|\t)/.test(container)) {
      if (paragraph) return line;
      boundaries.add(start); boundaries.add(offset);
      return blank(line);
    }
    // Headings and rules have their own inline scope and end a paragraph.
    const rule = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(unquoted);
    const standalone = rule || /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:=+|-+)[ \t]*$)/.test(container);
    if (rule) listIndent = 0;
    if (standalone) { paragraph = false; boundaries.add(start); boundaries.add(offset); }
    else paragraph = true;
    return line;
  }).join('\n');

  // Code spans can cross soft line breaks within a paragraph, but never pair
  // backticks across separate paragraphs, headings, lists, or code blocks.
  const points = [...boundaries].filter(point => point <= lines.length).sort((a, b) => a - b);
  points.push(lines.length);
  return points.slice(0, -1).map((start, index) => withoutInlineCode(lines.slice(start, points[index + 1]), blank)).join('');
}

// Explicit link/image destinations and the remaining prose share the same
// code and label masking. Handles quoted in labels or external URLs are not
// independent references. Preserve positions for callers scanning bare handles.
export function markdownReferenceText(markdown: string): { destinations: string[]; prose: string } {
  const prose = withoutCode(markdown);
  const destinations: string[] = [];
  const parts: string[] = [];
  let position = 0;
  const linkStart = /!?\[[^\]\n]*(?:\\\][^\]\n]*)*\]\(\s*/g;
  let match: RegExpExecArray | null;
  while ((match = linkStart.exec(prose))) {
    const start = linkStart.lastIndex;
    let end = start;
    let destination = '';
    if (prose[start] === '<') {
      end = prose.indexOf('>', start + 1);
      if (end < 0) continue;
      destination = prose.slice(start + 1, end);
      end++;
    } else {
      let depth = 0;
      for (; end < prose.length; end++) {
        const char = prose[end];
        if (char === '\\') { end++; continue; }
        if (char === '(') depth++;
        if (char === ')') { if (depth === 0) break; depth--; }
        if (/\s/.test(char) && depth === 0) break;
      }
      destination = prose.slice(start, end);
    }
    destinations.push(destination);
    const closing = prose.indexOf(')', end);
    const stop = closing < 0 ? end : closing + 1;
    parts.push(prose.slice(position, match.index), ' '.repeat(stop - match.index));
    position = stop;
    linkStart.lastIndex = stop;
  }
  parts.push(prose.slice(position));
  // Hashes embedded in ordinary URI tokens are destinations/fragments, not
  // bare record mentions, including query strings such as ?target=#action/id.
  const bareProse = parts.join('').replace(/(^|[\s(<{"'\[])([a-z][a-z0-9+.-]*:[^\s<>]+)/gi,
    (_match, boundary: string, token: string) => boundary + ' '.repeat(token.length));
  return { destinations, prose: bareProse };
}

function withoutInlineCode(text: string, blank: (text: string) => string): string {
  const ticks = /`+/g;
  let opening: RegExpExecArray | null;
  while ((opening = ticks.exec(text))) {
    const preceding = text.slice(0, opening.index).match(/\\+$/)?.[0].length ?? 0;
    if (preceding % 2) continue;
    const afterOpening = ticks.lastIndex;
    let closing: RegExpExecArray | null;
    while ((closing = ticks.exec(text))) {
      if (closing[0].length !== opening[0].length) continue;
      const end = ticks.lastIndex;
      text = text.slice(0, opening.index) + blank(text.slice(opening.index, end)) + text.slice(end);
      break;
    }
    if (!closing) ticks.lastIndex = afterOpening;
  }
  return text;
}

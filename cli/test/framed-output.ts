// Read the first authored-text block, stopping before the next metadata record
// or trailing query diagnostics. Decode only its framing indentation.
export function readTextBlock(output: string): string {
  const match = output.match(/^(?:content|body): \|\n((?:  [^\n]*(?:\n|$))+)/m);
  if (!match) throw new Error('Missing content/body block');
  const lines = match[1].split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map(line => line.slice(2)).join('\n');
}

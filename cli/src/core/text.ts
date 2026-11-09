import type {Manifest, ParseResult} from './types.js';

// Preserve ordinary values verbatim. JSON string quoting makes controls safe
// and remains unambiguous by also quoting literal JSON string representations.
export function formatScalar(value: string): string {
  let quotedLiteral = false;
  if (/^\s*"/.test(value)) {
    try { quotedLiteral = typeof JSON.parse(value) === 'string'; } catch { /* raw text */ }
  }
  if (!quotedLiteral && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return value;
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function formatList(values: string[]): string {
  return `[${values.map(value => {
    const escaped = formatScalar(value);
    if (escaped !== value) return escaped;
    return /[,\[\]{}"']|:\s|^[&*!?]/.test(value) || value !== value.trim() ? JSON.stringify(value) : value;
  }).join(', ')}]`;
}

// Render an instance with whatever its manifest provides, for agent-facing
// listings: identity leads, the data-directory path trails as a locating detail —
// `name — description  (path)` — falling back to just the path when the manifest
// carries no name/description. Whitespace (including newlines from block scalars)
// is collapsed so each instance stays on a single line.
export function formatInstanceLine(path: string, manifest: Manifest): string {
  const oneLine = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const label = [oneLine(manifest.name), oneLine(manifest.description)].filter(Boolean).map(formatScalar).join(' — ');
  return label ? `${label}  (${formatScalar(path)})` : formatScalar(path);
}

// Format an explicit observed manifest, including any read failure supplied by
// its owner or by the bootstrap operation preparing a recovery receipt.
export function formatInstanceEntry(path: string, result: ParseResult<Manifest>): string {
  const line = formatInstanceLine(path, result.value);
  const error = result.issues.find(issue => issue.code === 'read_error');
  return error ? `${line}\n    manifest: ${formatScalar(error.message)}` : line;
}

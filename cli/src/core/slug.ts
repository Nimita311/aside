// Longest slug we allow, in UTF-8 bytes. The full filename is "YYYY-MM-DD-<slug>.md"
// (slug + 14 bytes); common filesystems cap a single name at 255 bytes, so this keeps
// every ID a valid path with wide margin, even for 4-byte code points.
const MAX_SLUG_BYTES = 200;
const utf8 = new TextEncoder();

// Truncate to a UTF-8 byte budget, cutting only on a code-point boundary so a
// multi-byte character is never split into an invalid sequence.
function truncateToBytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of s) {
    const n = utf8.encode(ch).length;
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}

// Derive an entity's stable ID slug from its display name. Shared by capture (entry
// project/action IDs) and init (the instance `id`).
export function toKebabCase(name: string): string {
  // The slug is the entity's IDENTIFIER (and filename) — a stable handle for finding
  // and referencing it. The verbatim name is kept in the `name` field; the slug's only
  // job is stable identity: the same name, however it was typed, must yield the same id.
  // Two constraints shape it:
  //   1. Valid filename. Any run of characters a path (or the unquoted YAML the id is
  //      written into) can't carry — separators, control chars, punctuation, spaces,
  //      emoji — collapses to one dash, and the byte length is capped.
  //   2. Unique on case- and normalization-insensitive filesystems (APFS, Windows). We
  //      lowercase and Unicode-normalize, so names the filesystem folds together produce
  //      the identical slug — which is the filename verbatim, so our dedup set matches
  //      what lands on disk.
  //
  // We normalize with NFKC (compatibility), not merely NFC, *because* an id is an
  // identifier: presentation-only variants should converge. Fullwidth Ｑ３ (common from
  // CJK input methods), the ﬁ ligature, and Arabic presentation forms all fold to their
  // plain letters, so the same word typed differently — or referenced by an agent in
  // ASCII — resolves to one id. This is the standard rule for identifiers (Unicode
  // UAX #31; IDNA/UTS #46 for domains; Python PEP 3131). The rare lossy cases (x² -> x2,
  // ½ -> 1-2) effectively never appear in entity names, so the trade is worth it.
  // Faithfulness to the exact characters is the `name` field's job, not the id's.
  //
  // Letters, digits, and combining marks survive; marks are kept so scripts that carry
  // vowels/diacritics as marks (Thai, Devanagari, Arabic, Hebrew) aren't fragmented. A
  // leading mark has no base to attach to, so it is dropped, and the result must hold at
  // least one letter or digit to be a usable id.
  const slug = name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^[-\p{M}]+/gu, '')
    .replace(/-+$/g, '');
  // Cap to a filesystem-safe byte length, then re-trim if the cut landed on a dash.
  const result = truncateToBytes(slug, MAX_SLUG_BYTES).replace(/-+$/g, '');
  if (!/[\p{L}\p{N}]/u.test(result)) {
    throw new Error(`Cannot derive ID from name "${name}" — it must contain at least one letter or digit.`);
  }
  return result;
}

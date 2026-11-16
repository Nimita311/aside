import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {mergeMetadata, RECORD_FRONT_MATTER} from '../core/metadata.js';

export function serializeExistingRecord(file: string, canonical: string, fields: readonly string[], normalize: (record: string) => object, touchedFields?: readonly string[], metadataEdit?: (metadata: string) => string, preserveBody = false): string {
  let original: string;
  try { original = readFileSync(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return canonical;
    throw error;
  }
  const existing = original.match(RECORD_FRONT_MATTER);
  const desired = canonical.match(RECORD_FRONT_MATTER);
  if (!existing || !desired) {
    throw new Error(`Cannot update ${file}: existing record must have YAML front matter. Repair it before retrying.`);
  }
  // Tolerant parsing intentionally omits unrecognized values and nested extension
  // keys. Compare normalized values to detect edits, rather than treating that
  // omission as a request to erase the original YAML. Explicit field updates
  // still replace/clear their owned value, even when parsing omitted it.
  const before = normalize(original) as Record<string, unknown>;
  const after = normalize(canonical) as Record<string, unknown>;
  const editedFields = touchedFields ?? fields.filter(key => !isDeepStrictEqual(before[key], after[key]));
  const newline = existing[1].endsWith('\r\n') ? '\r\n' : '\n';
  let metadata = mergeMetadata(existing[2] ?? '', desired[2] ?? '', editedFields, file);
  if (metadataEdit) metadata = metadataEdit(metadata);
  const yaml = metadata.replace(/\n/g, newline);
  return `${existing[1]}${yaml}${newline}${existing[3]}${(preserveBody ? existing[4] : desired[4]) ?? ''}`;
}

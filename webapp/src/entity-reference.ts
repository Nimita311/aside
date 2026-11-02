import { ID_CHAR, type EntityRef } from '../lib/types';
import { isCalendarDate } from '../../cli/src/core/scheduling';

// Entries use wall timestamps, not named-entity slugs. Canonical IDs have
// minute precision; existing second-precision routes remain recognizable.
const ENTRY_ID = String.raw`\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?`;
const ENTRY_EXACT = new RegExp(`^${ENTRY_ID}$`);
const NAMED_EXACT = new RegExp(`^${ID_CHAR}+$`, 'u');
const INLINE = new RegExp(
  `#(project|action)/(${ID_CHAR}+)|(?<![\\p{L}\\p{N}\\p{M}_/\\\\])#(entry)/(${ENTRY_ID})(?!${ID_CHAR}|[:/+])`, 'gu',
);

export function parseEntityHandle(handle: string): EntityRef | null {
  const match = /^#(project|action|entry)\/(.+)$/.exec(handle);
  if (!match) return null;
  const type = match[1] as EntityRef['type'];
  const id = match[2];
  if (type !== 'entry') return NAMED_EXACT.test(id) ? { type, id } : null;
  return isEntryTimestamp(id) ? { type, id } : null;
}

export function isEntryTimestamp(id: string): boolean {
  return ENTRY_EXACT.test(id) && isCalendarDate(id.slice(0, 10));
}

export function entityMentions(text: string): { ref: EntityRef; index: number; length: number }[] {
  const mentions: { ref: EntityRef; index: number; length: number }[] = [];
  for (const match of text.matchAll(INLINE)) {
    const ref = parseEntityHandle(match[0]);
    if (ref) mentions.push({ ref, index: match.index, length: match[0].length });
  }
  return mentions;
}

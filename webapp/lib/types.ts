export type {
  Entry,
  ProjectFrontMatter,
  Project,
  ActionFrontMatter,
  Action,
  ArtifactFrontMatter,
  Artifact,
  IndexItem,
  Manifest,
} from '../../cli/src/core/types';
import { formatDate as toDateStr, formatTimestamp as toStampStr } from '../../cli/src/core/date';
import { MEDIA_TYPES, type MediaKind } from '../../cli/src/core/media';

export * from '../../cli/src/core/record-reference';
export { toDateStr, toStampStr };

// How an asset renders in the reader, chosen by file extension. Media kinds
// embed the file by URL; 'markdown' and 'other' fall back to reading content.
// Extensionless files are notes, so they render as markdown.
export type AssetMediaKind = 'markdown' | 'webpage' | MediaKind | 'other';

export function assetMediaKind(path: string): AssetMediaKind {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (!ext) return 'markdown';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'webpage';
  return MEDIA_TYPES[ext]?.kind ?? 'other';
}

// Heuristic: does text decoded from a file look like binary rather than
// something worth showing verbatim? A NUL byte or a scatter of U+FFFD
// replacement chars (invalid UTF-8, produced when bytes aren't real text)
// means it shouldn't be shown as raw text.
export function looksBinary(text: string): boolean {
  if (text.includes('\u0000')) return true;
  const sample = Math.min(text.length, 2000);
  let bad = 0;
  for (let i = 0; i < sample; i++) if (text.charCodeAt(i) === 0xfffd) bad++;
  return sample > 0 && bad / sample > 0.1;
}

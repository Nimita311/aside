// Entity icons: the drawings (entity-icon-drawings.ts) and the states that
// records put them in — an action's lifecycle from its chip marks, a page
// from how the reader renders a file or an artifact — and those of the smart
// elements content mentions: a date by its value, a location by what it saves.

import { assetMediaKind, type Artifact } from '../lib/types';
import { artifactContentFilename } from '../../cli/src/core/artifact-reference';
import type { DateReference } from './date-reference';
import type { LocationReference } from './location-reference';
import type { RefStatus } from './instance';

export { ICON_SIZE, iconMarkup, iconStates, setEntityIcon, type IconKind } from './entity-icon-drawings';
export { setReferenceIcon, setupEntityIconSizing } from './entity-icon-sizing';

// The icon state of an entity, from the marks its chips wear.
export function actionIconState(marks: RefStatus[]): string {
  for (const state of ['done', 'cancelled', 'recurring', 'slipped', 'backlog'] as const) if (marks.includes(state)) return state;
  return 'scheduled';
}

export function projectIconState(marks: RefStatus[]): string {
  return marks.includes('ended') ? 'ended' : 'live';
}

export function refIconState(type: 'project' | 'action' | 'entry', marks: RefStatus[]): string {
  return type === 'project' ? projectIconState(marks) : type === 'action' ? actionIconState(marks) : 'recorded';
}

// Plain-text files the reader shows verbatim, as it does Markdown.
const TEXT_FILES = /\.(txt|text|log|csv|tsv|json|jsonl|ya?ml|toml|ini|conf|cfg|xml|vtt|srt|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|swift|sh|zsh|sql)$/i;

// A file's page, by how the reader renders it: Markdown and plain text share
// the text page; a file without a preview is a plain page, promising nothing.
export function fileIconState(path: string): string {
  const kind = assetMediaKind(path);
  if (kind === 'markdown') return 'text';
  if (kind === 'other') return TEXT_FILES.test(path) ? 'text' : 'file';
  return kind;
}

// An artifact reads as what it opens: a Markdown body is text, a lone
// attachment shows that file's page, and several attachments with no body
// stack into a collection.
export function artifactIconState(artifact: Artifact | undefined, filename?: string): string {
  if (filename !== undefined) return fileIconState(filename);
  if (!artifact) return 'text';
  const content = artifactContentFilename(artifact);
  if (content) return fileIconState(content);
  return !artifact.body.trim() && (artifact.frontMatter.attachments?.length ?? 0) > 1 ? 'collection' : 'text';
}

// A date's page by its value: a calendar date is a day, an interval of them a
// range, and anything with a clock — one time or a timed interval — a time.
export function dateIconState(ref: DateReference): string {
  if (ref.start.length > 10) return 'time';
  return ref.end ? 'range' : 'day';
}

// A location pins its point once it saves coordinates; postal text alone
// pends until an agent geocodes it.
export function locationIconState(ref: LocationReference): string {
  return ref.geo ? 'geo' : 'postal';
}

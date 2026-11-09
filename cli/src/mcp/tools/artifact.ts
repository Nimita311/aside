import type {Store} from '../../source/store.js';
import type {ArtifactImport, PreparedArtifactSource} from '../../source/artifact-source.js';
export type {ArtifactImport} from '../../source/artifact-source.js';
import {formatAttachmentFiles} from '../format.js';
import {formatList, formatScalar} from '../../core/text.js';
import {formatDate, formatTimestamp} from '../../core/date.js';
import {toKebabCase} from '../../core/slug.js';
import {artifactAttachmentPath, artifactFilePath, artifactHandle, artifactContentFilename} from '../../core/artifact.js';
import type {Artifact, ArtifactFrontMatter} from '../../core/types.js';
import {resolveMarkdownSource} from './content-source.js';
import {trackMutation} from '../../source/mutation-result.js';

export interface CreateArtifactArgs {
  name: string;
  description: string;
  body?: string;
  body_file?: string;
  files?: ArtifactImport[];
}

export interface UpdateArtifactArgs {
  id: string;
  name?: string;
  description?: string;
  body?: string;
  body_file?: string;
  files?: ArtifactImport[];
  remove_files?: string[];
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty.`);
}

function setAttachments(frontMatter: ArtifactFrontMatter, attachments: string[]): void {
  if (attachments.length) frontMatter.attachments = attachments;
  else delete frontMatter.attachments;
}

function response(store: Store, id: string, artifact: Artifact, imports: PreparedArtifactSource['imports'], removals: PreparedArtifactSource['removals'] = []): string {
  const lines = [`artifact: ${formatScalar(artifactHandle(id))}`, `name: ${formatScalar(artifact.frontMatter.name)}`, `created: ${formatScalar(artifact.frontMatter.created)}`];
  if (artifact.frontMatter.attachments?.length) lines.push(`attachments: ${formatList(artifact.frontMatter.attachments)}`);
  lines.push(...formatAttachmentFiles(store.getAttachmentFiles(id), id, artifact.frontMatter.attachments ?? []));
  const target = artifactContentFilename(artifact);
  if (target !== undefined) lines.push(`target: ${formatScalar(artifactHandle(id, target))}`);
  if (imports.length) {
    lines.push('files_imported:');
    lines.push(...imports.map(file => `  ${formatScalar(artifactHandle(id, file.filename))}`));
  }
  if (removals.length) {
    lines.push('files_removed:');
    lines.push(...removals.map(file => `  ${formatScalar(artifactHandle(id, file.filename))}`));
  }
  return lines.join('\n');
}

export function handleCreateArtifact(store: Store, args: CreateArtifactArgs, now = new Date()): string {
  return createArtifact(store, args, now).text;
}

// Structured outcome shared by CLI receipts and GraphQL; never recover IDs
// by parsing the human-readable response.
export function createArtifact(store: Store, args: CreateArtifactArgs, now = new Date()): { id: string; text: string } {
  return trackMutation(store, () => prepareCreateArtifact(store, args, now).commit()).value;
}

export interface PreparedArtifactCreate {
  id: string;
  artifact: Artifact;
  contentFile?: string;
  commit: () => {id: string; text: string};
}

/** Resolve every source and validate the complete create without durable writes. */
export function prepareCreateArtifact(store: Store, args: CreateArtifactArgs, now = new Date()): PreparedArtifactCreate {
  requireText(args.name, 'name');
  requireText(args.description, 'description');
  const id = `${formatDate(now)}-${toKebabCase(args.name)}`;
  const file = artifactFilePath(store.getDataDir(), id);
  const source = store.prepareArtifactSource(id, {creating: true, file, imports: args.files});
  const body = resolveMarkdownSource(args.body, args.body_file, 'body') ?? '';
  const frontMatter: ArtifactFrontMatter = { name: args.name, created: formatTimestamp(now) };
  const artifact = { frontMatter, body };
  const {imports} = source;
  setAttachments(frontMatter, source.attachments);
  source.validate(artifact);
  const primary = artifactContentFilename(artifact);
  const contentFile = primary === undefined ? undefined : imports.find(imported => imported.filename === primary)?.source
    ?? artifactAttachmentPath(store.getDataDir(), id, primary);
  return {id, artifact, ...(contentFile ? {contentFile} : {}), commit: () => {
    source.commitFiles();
    store.saveArtifact(id, frontMatter, body, file);
    store.addIndexEntry('artifacts', file, id, args.description);
    return { id, text: response(store, id, store.getArtifact(id)!, imports) };
  }};
}

export function handleUpdateArtifact(store: Store, args: UpdateArtifactArgs): string {
  return trackMutation(store, () => updateArtifact(store, args)).value;
}
function updateArtifact(store: Store, args: UpdateArtifactArgs): string {
  const current = store.getArtifact(args.id);
  const file = store.getArtifactFile(args.id);
  if (!current || !file) throw new Error(`Cannot update artifact "${args.id}" — not found.\nHint: query artifacts to verify the ID.`);
  if (args.name !== undefined) requireText(args.name, 'name');
  if (args.description !== undefined) requireText(args.description, 'description');
  const frontMatter = { ...current.frontMatter };
  if (args.name !== undefined) frontMatter.name = args.name;
  const replacement = resolveMarkdownSource(args.body, args.body_file, 'body');
  const source = store.prepareArtifactSource(args.id, {creating: false, file, updateDescription: args.description !== undefined,
    imports: args.files, removeFiles: args.remove_files, preserveBody: replacement === undefined});
  const artifact = {frontMatter, body: replacement ?? source.currentBody!};
  const {imports, removals} = source;
  // Attachments reflect the physical inventory, including when tolerant parsing
  // omitted a malformed list. Preflight the same owned fields the write updates.
  const fields = ['attachments', ...(args.name !== undefined ? ['name'] : [])];
  setAttachments(frontMatter, source.attachments);
  source.validate(artifact, fields, replacement === undefined);
  source.commitFiles();
  if (replacement !== undefined || args.name !== undefined) {
    store.saveArtifact(args.id, frontMatter, replacement, file, fields);
  } else {
    store.refreshArtifactAttachments(args.id);
  }
  let warning = '';
  if (args.description !== undefined && !store.setIndexEntry('artifacts', args.id, args.description)) {
    warning = '\nwarning: description not saved — artifact index entry could not be updated (run `aside instance validate`)';
  }
  return `updated: ${formatScalar(artifactHandle(args.id))}${warning}\n${response(store, args.id, store.getArtifact(args.id)!, imports, removals)}`;
}

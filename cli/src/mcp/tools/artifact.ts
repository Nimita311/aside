import {
  accessSync, closeSync, constants, copyFileSync, existsSync, fstatSync,
  lstatSync, mkdirSync, openSync, renameSync, unlinkSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { Store } from '../store.js';
import { formatAttachmentFiles, formatList, formatScalar } from '../format.js';
import { formatDate, formatTimestamp } from '../../core/date.js';
import { toKebabCase } from '../../core/slug.js';
import {
  artifactAttachmentPath, artifactFilePath, artifactHandle, assertAttachmentFilename,
  artifactContentFilename, collectArtifactReferenceSources, isArtifactStagingFilename, listArtifactAttachments, parseArtifactHandle,
} from '../../core/artifact.js';
import type { Artifact, ArtifactFrontMatter } from '../../core/types.js';
import { resolveMarkdownSource } from './content-source.js';
import { serializeArtifact } from './serialize.js';
import { parseArtifactFile } from '../../core/parser.js';
import { persistMutationWrite, trackMutation } from './mutation-result.js';
import { assertManagedPath, readManagedText } from '../../core/managed-path.js';

export interface ArtifactImport {
  source: string;
  filename?: string;
}

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

interface ResolvedImport extends ArtifactImport {
  filename: string;
  destination: string;
}

interface ResolvedRemoval {
  filename: string;
  destination: string;
}

function foldedFilename(filename: string): string {
  return filename.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must not be empty.`);
}

// Destination components below the instance root must be ordinary directories
// and files. In particular, imports cannot follow a same-ID folder symlink.
function preflightDestination(dataDir: string, file: string): void {
  let parent = dirname(assertManagedPath(dataDir, file, 'file', true));
  while (!existsSync(parent)) parent = dirname(parent);
  accessSync(parent, constants.W_OK);
}

function resolveImports(store: Store, id: string, files: ArtifactImport[], creating: boolean): ResolvedImport[] {
  const seen = new Set<string>();
  return files.map((file) => {
    if (!isAbsolute(file.source)) throw new Error('File source must be an absolute path.');
    const filename = file.filename ?? basename(file.source);
    assertAttachmentFilename(filename);
    if (isArtifactStagingFilename(filename)) throw new Error(`Imported filename "${filename}" is reserved for artifact staging files.`);
    const folded = foldedFilename(filename);
    if (seen.has(folded)) throw new Error(`Duplicate imported filename "${filename}".`);
    seen.add(folded);
    const destination = artifactAttachmentPath(store.getDataDir(), id, filename);
    preflightDestination(store.getDataDir(), destination);
    if (creating && existsSync(destination)) {
      throw new Error(`Imported filename "${filename}" already exists. Choose another filename.`);
    }
    let fd: number | undefined;
    try {
      fd = openSync(file.source, constants.O_RDONLY | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) throw new Error('expected a regular file');
      return { source: file.source, filename, destination };
    } catch (err) {
      throw new Error(`Cannot import "${file.source}": ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  });
}

function resolveRemovals(store: Store, id: string, filenames: string[], imports: ResolvedImport[]): ResolvedRemoval[] {
  const existing = new Set(listArtifactAttachments(store.getDataDir(), id));
  const imported = new Set(imports.map(file => foldedFilename(file.filename)));
  const seen = new Set<string>();
  return filenames.map(filename => {
    assertAttachmentFilename(filename);
    const folded = foldedFilename(filename);
    if (seen.has(folded)) throw new Error(`Duplicate removed filename "${filename}".`);
    seen.add(folded);
    if (imported.has(folded)) throw new Error(`Cannot import and remove the same filename "${filename}".`);
    if (!existing.has(filename)) throw new Error(`Attachment "${filename}" does not exist as an exact ordinary filename.`);
    const destination = artifactAttachmentPath(store.getDataDir(), id, filename);
    preflightDestination(store.getDataDir(), destination);
    return { filename, destination };
  });
}

function prospectiveAttachments(store: Store, id: string, imports: ResolvedImport[], removals: ResolvedRemoval[]): string[] {
  const filenames = new Set(listArtifactAttachments(store.getDataDir(), id));
  for (const file of removals) filenames.delete(file.filename);
  for (const file of imports) filenames.add(file.filename);
  return [...filenames].sort();
}

function setAttachments(frontMatter: ArtifactFrontMatter, attachments: string[]): void {
  if (attachments.length) frontMatter.attachments = attachments;
  else delete frontMatter.attachments;
}

function preflightRecord(store: Store, id: string, artifact: Artifact, imports: ResolvedImport[], removals: ResolvedRemoval[] = [], fields?: readonly string[], preserveBody = false): void {
  // Validate the prospective YAML merge before changing any attachment bytes.
  artifact = parseArtifactFile(serializeArtifact(artifact.frontMatter, preserveBody ? undefined : artifact.body, artifactFilePath(store.getDataDir(), id), fields)).value;
  const artifacts = new Map(store.getArtifacts());
  artifacts.set(id, artifact);
  const imported = new Map<string, Uint8Array | null>(imports.map(file => [artifactHandle(id, file.filename), new Uint8Array()]));
  const removed = new Set(removals.map(file => artifactHandle(id, file.filename)));
  for (const handle of removed) imported.set(handle, null);
  // Validate file selections from the resulting record bodies. Imported files
  // supply presence only; their bytes never create references.
  const handle = artifactHandle(id);
  const roots = store.getArtifactReferenceSources().filter(source => source.handle !== handle);
  roots.push({ handle, markdown: artifact.body });
  let prospective = collectArtifactReferenceSources(store.getDataDir(), roots, artifacts, imported);
  // A case/normalization alias of a removed filename must also be absent in the
  // overlay. Separate ordinary hardlinks remain present under their own names.
  const existingNames = new Set(listArtifactAttachments(store.getDataDir(), id));
  let aliasedRemoval = false;
  for (const reference of prospective.attachments) {
    const ref = parseArtifactHandle(reference);
    if (ref?.id !== id || ref.filename === undefined || existingNames.has(ref.filename)) continue;
    const referencedPath = artifactAttachmentPath(store.getDataDir(), id, ref.filename);
    if (!existsSync(referencedPath)) continue;
    const referenced = lstatSync(referencedPath);
    if (removals.some(file => {
      const target = lstatSync(file.destination);
      return target.dev === referenced.dev && target.ino === referenced.ino;
    })) {
      imported.set(reference, null);
      removed.add(reference);
      aliasedRemoval = true;
    }
  }
  if (aliasedRemoval) prospective = collectArtifactReferenceSources(store.getDataDir(), roots, artifacts, imported);
  const selected = new Set(prospective.attachments);
  const dangling = prospective.issues.filter(issue => [...removed].some(handle => issue.message.startsWith(`${handle}:`)));
  if (dangling.length) throw new Error(dangling.map(issue => issue.message).join('\n'));

  // Case-insensitive and normalization-insensitive filesystems can resolve
  // different filenames to the same file. Preserve the spelling of known
  // references so an import cannot bypass the exact-handle overlay.
  const known = new Set([
    ...[...existingNames].map(filename => artifactHandle(id, filename)),
    ...store.getReferencedArtifactFiles(), ...selected,
  ]);
  for (const file of imports) {
    if (!existsSync(file.destination)) continue;
    const destination = lstatSync(file.destination);
    for (const reference of known) {
      const ref = parseArtifactHandle(reference);
      if (ref?.id !== id || ref.filename === undefined || ref.filename === file.filename) continue;
      // Separate indexed directory entries may be hardlinks. Replacing one
      // preserves the others; only unlisted spellings can be filesystem aliases.
      if (existingNames.has(file.filename) && existingNames.has(ref.filename)) continue;
      const path = artifactAttachmentPath(store.getDataDir(), id, ref.filename);
      if (!existsSync(path)) continue;
      const target = lstatSync(path);
      if (target.dev === destination.dev && target.ino === destination.ino) {
        throw new Error(`Imported filename "${file.filename}" aliases referenced filename "${ref.filename}". Use the referenced filename.`);
      }
    }
  }

  // Validate the edited record and every replacement still selected anywhere.
  // Unrelated existing errors do not prevent correcting this artifact.
  const replacements = imports.map(file => artifactHandle(id, file.filename)).filter(file => selected.has(file));
  const result = collectArtifactReferenceSources(store.getDataDir(), [
    { handle, markdown: artifact.body },
    { handle, markdown: replacements.join('\n') },
  ], artifacts, imported);
  if (result.issues.length) {
    throw new Error(result.issues.map(issue => issue.message).join('\n'));
  }
}

function importFiles(store: Store, id: string, imports: ResolvedImport[], removals: ResolvedRemoval[] = []): void {
  for (const file of [...imports, ...removals]) preflightDestination(store.getDataDir(), file.destination);
  const staged: { temp: string; destination: string }[] = [];
  try {
    // A destination can also be another import's source. Snapshot every source
    // before replacing any file so swaps and copies use the original bytes.
    for (const file of imports) {
      mkdirSync(dirname(file.destination), { recursive: true });
      const temp = join(dirname(file.destination), `.${randomUUID()}.tmp`);
      staged.push({ temp, destination: file.destination });
      copyFileSync(file.source, temp, constants.COPYFILE_EXCL);
    }
    for (const file of removals) persistMutationWrite(store,
      {kind: 'attachment', id: artifactHandle(id, file.filename), effect: 'REMOVED', path: file.destination}, () => unlinkSync(file.destination));
    for (let index = 0; index < staged.length; index++) {
      const file = staged[index];
      persistMutationWrite(store, {kind: 'attachment', id: artifactHandle(id, imports[index].filename),
        effect: existsSync(file.destination) ? 'UPDATED' : 'CREATED', path: file.destination}, () => renameSync(file.temp, file.destination));
    }
  } finally {
    for (const file of staged) {
      try { unlinkSync(file.temp); } catch { /* already renamed or failed copy */ }
    }
  }
}

function response(dataDir: string, id: string, artifact: Artifact, imports: ResolvedImport[], removals: ResolvedRemoval[] = []): string {
  const lines = [`artifact: ${formatScalar(artifactHandle(id))}`, `name: ${formatScalar(artifact.frontMatter.name)}`, `created: ${formatScalar(artifact.frontMatter.created)}`];
  if (artifact.frontMatter.attachments?.length) lines.push(`attachments: ${formatList(artifact.frontMatter.attachments)}`);
  lines.push(...formatAttachmentFiles(dataDir, id, artifact.frontMatter.attachments ?? []));
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

// Structured outcome shared by legacy receipts and GraphQL; never recover IDs
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
  preflightDestination(store.getDataDir(), file);
  if (store.getArtifact(id) || existsSync(file)) {
    throw new Error(`Artifact ID "${id}" already exists. Choose another name or use update_artifact.`);
  }
  const indexFile = join(dirname(file), 'index.yaml');
  preflightDestination(store.getDataDir(), indexFile);
  if (existsSync(indexFile)) readManagedText(store.getDataDir(), indexFile);
  const body = resolveMarkdownSource(args.body, args.body_file, 'body') ?? '';
  const frontMatter: ArtifactFrontMatter = { name: args.name, created: formatTimestamp(now) };
  const artifact = { frontMatter, body };
  const imports = resolveImports(store, id, args.files ?? [], true);
  setAttachments(frontMatter, prospectiveAttachments(store, id, imports, []));
  preflightRecord(store, id, artifact, imports);
  const primary = artifactContentFilename(artifact);
  const contentFile = primary === undefined ? undefined : imports.find(imported => imported.filename === primary)?.source
    ?? artifactAttachmentPath(store.getDataDir(), id, primary);
  return {id, artifact, ...(contentFile ? {contentFile} : {}), commit: () => {
    importFiles(store, id, imports);
    store.saveArtifact(id, frontMatter, body, file);
    store.addIndexEntry('artifacts', file, id, args.description);
    return { id, text: response(store.getDataDir(), id, store.getArtifact(id)!, imports) };
  }};
}

export function handleUpdateArtifact(store: Store, args: UpdateArtifactArgs): string {
  return trackMutation(store, () => updateArtifact(store, args)).value;
}
function updateArtifact(store: Store, args: UpdateArtifactArgs): string {
  const current = store.getArtifact(args.id);
  const file = store.getArtifactFile(args.id);
  if (!current || !file) throw new Error(`Cannot update artifact "${args.id}" — not found.\nHint: use query_artifacts to verify the ID.`);
  if (file !== artifactFilePath(store.getDataDir(), args.id)) {
    throw new Error(`Cannot update artifact "${args.id}" — record is outside its prescribed creation-year location. Run aside instance validate.`);
  }
  if (args.name !== undefined) requireText(args.name, 'name');
  if (args.description !== undefined) requireText(args.description, 'description');
  const frontMatter = { ...current.frontMatter };
  if (args.name !== undefined) frontMatter.name = args.name;
  const replacement = resolveMarkdownSource(args.body, args.body_file, 'body');
  preflightDestination(store.getDataDir(), file);
  const artifact = { frontMatter, body: replacement ?? parseArtifactFile(readManagedText(store.getDataDir(), file)).value.body };
  if (args.description !== undefined) {
    const indexFile = join(dirname(file), 'index.yaml');
    preflightDestination(store.getDataDir(), indexFile);
    if (existsSync(indexFile)) readManagedText(store.getDataDir(), indexFile);
  }
  const imports = resolveImports(store, args.id, args.files ?? [], false);
  const removals = resolveRemovals(store, args.id, args.remove_files ?? [], imports);
  // Attachments reflect the physical inventory, including when tolerant parsing
  // omitted a malformed list. Preflight the same owned fields the write updates.
  const fields = ['attachments', ...(args.name !== undefined ? ['name'] : [])];
  setAttachments(frontMatter, prospectiveAttachments(store, args.id, imports, removals));
  preflightRecord(store, args.id, artifact, imports, removals, fields, replacement === undefined);
  importFiles(store, args.id, imports, removals);
  if (replacement !== undefined || args.name !== undefined) {
    store.saveArtifact(args.id, frontMatter, replacement, file, fields);
  } else {
    store.refreshArtifactAttachments(args.id);
  }
  let warning = '';
  if (args.description !== undefined && !store.setIndexEntry('artifacts', args.id, args.description)) {
    warning = '\nwarning: description not saved — artifact index entry could not be updated (run `aside instance validate`)';
  }
  return `updated: ${formatScalar(artifactHandle(args.id))}${warning}\n${response(store.getDataDir(), args.id, store.getArtifact(args.id)!, imports, removals)}`;
}

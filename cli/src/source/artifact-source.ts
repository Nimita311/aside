import {
  accessSync, closeSync, constants, copyFileSync, existsSync, fstatSync,
  lstatSync, mkdirSync, openSync, renameSync, unlinkSync,
} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {basename, dirname, isAbsolute, join} from 'node:path';
import type {Store} from './store.js';
import {
  artifactAttachmentPath, artifactFilePath, artifactHandle, assertAttachmentFilename,
  collectArtifactReferenceSources, isArtifactStagingFilename, listArtifactAttachments, parseArtifactHandle,
} from '../core/artifact.js';
import type {Artifact} from '../core/types.js';
import {parseArtifactFile} from '../core/parser.js';
import {assertManagedPath, readManagedText} from '../core/managed-path.js';
import {serializeArtifact} from './serialize.js';
import {persistMutationWrite} from './mutation-result.js';

export interface ArtifactImport {
  source: string;
  filename?: string;
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

export interface ArtifactSourceOptions {
  creating: boolean;
  file: string;
  updateDescription?: boolean;
  imports?: ArtifactImport[];
  removeFiles?: string[];
  preserveBody?: boolean;
}

export interface PreparedArtifactSource {
  currentBody?: string;
  attachments: string[];
  imports: ResolvedImport[];
  removals: ResolvedRemoval[];
  validate(artifact: Artifact, fields?: readonly string[], preserveBody?: boolean): void;
  commitFiles(): void;
}

/** Current source inspection and attachment persistence for one owner mutation. */
export function prepareArtifactSource(store: Store, id: string, options: ArtifactSourceOptions): PreparedArtifactSource {
  const {file, creating} = options, dataDir = store.getDataDir();
  if (file !== artifactFilePath(dataDir, id)) {
    throw new Error(`Cannot update artifact "${id}" — record is outside its prescribed creation-year location. Run aside instance validate.`);
  }
  preflightDestination(dataDir, file);
  if (creating && (store.getArtifact(id) || existsSync(file))) {
    throw new Error(`Artifact ID "${id}" already exists. Choose another name or use updateArtifact through mutate.`);
  }
  const currentBody = options.preserveBody ? parseArtifactFile(readManagedText(dataDir, file)).value.body : undefined;
  if (creating || options.updateDescription) {
    const indexFile = join(dirname(file), 'index.yaml');
    preflightDestination(dataDir, indexFile);
    if (existsSync(indexFile)) readManagedText(dataDir, indexFile);
  }
  const imports = resolveImports(store, id, options.imports ?? [], creating);
  const removals = resolveRemovals(store, id, options.removeFiles ?? [], imports);
  const attachments = prospectiveAttachments(store, id, imports, removals);
  let validated = false;
  return {
    ...(currentBody === undefined ? {} : {currentBody}), attachments, imports, removals,
    validate: (artifact, fields, preserveBody = false) => {
      validated = false;
      preflightRecord(store, id, artifact, imports, removals, fields, preserveBody);
      validated = true;
    },
    commitFiles: () => {
      if (!validated) throw new Error('Artifact source must be validated before committing attachment changes.');
      importFiles(store, id, imports, removals);
    },
  };
}

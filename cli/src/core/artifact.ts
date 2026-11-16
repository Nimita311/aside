import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { artifactReferenceTraversal, type ArtifactLoadResult, type ArtifactTraversal } from './artifact-traversal.js';
import type { Artifact } from './types.js';
import { contentAttachmentPath } from './content-attachment.js';
import { assertManagedPath } from './managed-path.js';

import { artifactAttachmentRelativePath, artifactRecordPath, assertArtifactId, assertAttachmentFilename, parseArtifactHandle, type ArtifactReferenceSource } from './artifact-reference.js';
import { errorMessage } from './error.js';
export * from './artifact-reference.js';

export function artifactFilePath(dataDir: string, id: string): string {
  return join(dataDir, artifactRecordPath(id));
}

export function artifactAttachmentPath(dataDir: string, id: string, filename: string): string {
  return join(dataDir, artifactAttachmentRelativePath(id, filename));
}

// Reserved names used by attachment imports and crash-safe record writes.
export function isArtifactStagingFilename(filename: string): boolean {
  return /^\.(?:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}|\d{13}-[a-z0-9]+)\.tmp$/.test(filename);
}

// List only immediate regular files, with exact names preserved. Missing
// directories remain empty; every existing managed ancestor must be ordinary.
export function listArtifactAttachments(dataDir: string, id: string): string[] {
  assertArtifactId(id);
  dataDir = resolve(dataDir);
  const directory = assertManagedPath(dataDir, join(dataDir, 'artifacts', id.slice(0, 4), id), 'directory', true);
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(file => file.isFile() && !isArtifactStagingFilename(file.name))
      .map(file => {
        assertAttachmentFilename(file.name);
        return file.name;
      })
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// Validate filenames selected by record references or implicit file content.
// Imports overlay disk during mutation preflight; file contents never supply
// additional references.
export function collectArtifactReferenceSources(
  dataDir: string,
  sources: ArtifactReferenceSource[],
  artifacts: ReadonlyMap<string, Artifact>,
  importedFiles?: ReadonlyMap<string, Uint8Array | null>,
): ArtifactTraversal {
  const traversal = artifactReferenceTraversal(sources, artifacts);
  let next = traversal.next();
  while (!next.done) {
    const request = next.value;
    let result: ArtifactLoadResult;
    try {
      const imported = importedFiles?.get(request.handle);
      if (imported === null) throw new Error('target has been removed');
      if (imported === undefined) {
        const reference = parseArtifactHandle(request.handle)!;
        contentAttachmentPath(dataDir, reference.id, reference.filename!);
      }
      result = {};
    } catch (err) {
      result = { error: errorMessage(err) };
    }
    next = traversal.next(result);
  }
  return next.value;
}

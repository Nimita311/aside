// Resolve attachment targets without following any managed-directory or
// file symlink. Reference discovery never reads attachment contents.
import { artifactAttachmentPath, isArtifactStagingFilename } from './artifact.js';
import { assertManagedPath } from './managed-path.js';
import { resolve } from 'node:path';

export function contentAttachmentPath(root: string, id: string, filename: string): string {
  if (isArtifactStagingFilename(filename)) throw new Error('Reserved attachment staging file');
  root = resolve(root);
  return assertManagedPath(root, artifactAttachmentPath(root, id, filename), 'file');
}

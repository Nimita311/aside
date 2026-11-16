import { artifactAttachmentRelativePath, assertAttachmentFilename, parseArtifactHandle } from '../../cli/src/core/artifact-reference';
import type { Artifact } from '../../cli/src/core/types';

export function artifactResourcePath(sourceArtifact: string, reference: string, lookup: (id: string) => Artifact | undefined): string {
  const handle = parseArtifactHandle(reference);
  const id = handle?.id ?? sourceArtifact;
  const filename = handle ? handle.filename : reference.replace(/^\.\//, '');
  if (!filename) throw new Error('Resource reference must name an attachment.');
  assertAttachmentFilename(filename);
  if (!lookup(id)?.frontMatter.attachments?.includes(filename)) throw new Error('Resource must be an indexed attachment in the selected instance.');
  return artifactAttachmentRelativePath(id, filename);
}

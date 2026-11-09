import { artifactHandle, assertArtifactId, assertAttachmentFilename, parseArtifactHandle, type ArtifactReference } from '../../cli/src/core/artifact-reference';

// A query has a role because navigation explicitly names its attachment.
// Neither an artifact ID nor a conventional filename registers a view.
export function entrySourceReference(value: string): ArtifactReference & { filename: string } {
  const ref = parseArtifactHandle(value);
  if (!ref || ref.filename === undefined) throw new Error('A timeline query must name an artifact attachment.');
  assertArtifactId(ref.id);
  assertAttachmentFilename(ref.filename);
  return ref as ArtifactReference & { filename: string };
}

export function canonicalEntrySource(value: string): string {
  const ref = entrySourceReference(value);
  return artifactHandle(ref.id, ref.filename);
}

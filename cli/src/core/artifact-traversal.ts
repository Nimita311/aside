// Portable artifact target validation. Attachments never originate references;
// callers only confirm selected files exist as ordinary managed files.
import type { Artifact, ParseIssue } from './types.js';
import { artifactContentFilename, artifactHandle, artifactAttachmentRelativePath, assertArtifactId, parseArtifactHandle, extractArtifactReferences, type ArtifactReference, type ArtifactReferenceSource } from './artifact-reference.js';

export interface ArtifactLoad { handle: string; path: string }
export interface ArtifactLoadResult { error?: string }
export interface ArtifactTraversal {
  sources: ArtifactReferenceSource[];
  issues: ParseIssue[];
  attachments: string[];
  availableAttachments: string[];
}

export function* artifactReferenceTraversal(
  sources: ArtifactReferenceSource[],
  artifacts: ReadonlyMap<string, Artifact>,
): Generator<ArtifactLoad, ArtifactTraversal, ArtifactLoadResult> {
  const all = sources.filter(source => parseArtifactHandle(source.handle)?.filename === undefined);
  const issues: ParseIssue[] = [];
  const attachments = new Set<string>();
  const availableAttachments = new Set<string>();
  const contents = new Set<string>();
  const checked = new Set<string>();
  const issue = (source: string, code: string, message: string) => {
    issues.push({ severity: 'error', code, message, file: source });
  };
  function* load(ref: ArtifactReference, source: string): Generator<ArtifactLoad, void, ArtifactLoadResult> {
    let handle: string;
    try { handle = artifactHandle(ref.id, ref.filename); }
    catch (err) { issue(source, 'artifact_reference_invalid', String((err as Error).message)); return; }
    if (ref.filename !== undefined) attachments.add(handle);
    const artifact = artifacts.get(ref.id);
    if (!artifact) { issue(source, 'artifact_reference_missing', `${handle}: artifact not found`); return; }
    if (!contents.has(ref.id)) {
      contents.add(ref.id);
      const filename = artifactContentFilename(artifact);
      if (filename !== undefined) yield* load({ id: ref.id, filename }, `#artifact/${ref.id}`);
    }
    if (ref.filename === undefined) return;
    if (checked.has(`${source}\0${handle}`)) return;
    checked.add(`${source}\0${handle}`);
    const loaded = yield { handle, path: artifactAttachmentRelativePath(ref.id, ref.filename) };
    if (loaded.error !== undefined) {
      issue(source, 'artifact_attachment_read_error', `${handle}: ${loaded.error}`);
      return;
    }
    availableAttachments.add(handle);
  }
  for (let i = 0; i < all.length; i++) {
    const source = all[i];
    const own = parseArtifactHandle(source.handle);
    if (own && own.filename === undefined && artifacts.has(own.id)) {
      try { assertArtifactId(own.id); }
      catch { continue; }
      if (!contents.has(own.id)) {
        contents.add(own.id);
        const filename = artifactContentFilename(artifacts.get(own.id)!);
        if (filename !== undefined) yield* load({ id: own.id, filename }, source.handle);
      }
    }
    const refs = extractArtifactReferences(source.markdown);
    for (const reference of refs) yield* load(reference, source.handle);
  }
  return { sources: all, issues, attachments: Array.from(attachments), availableAttachments: Array.from(availableAttachments) };
}

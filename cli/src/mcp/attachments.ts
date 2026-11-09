import type {AttachmentFile} from '../core/attachment-metadata.js';
export type {AttachmentFile} from '../core/attachment-metadata.js';

/** Format an explicit lifecycle observation; never inspect attachment paths. */
export function attachmentFiles(snapshot: readonly AttachmentFile[] | undefined, id: string, filenames: readonly string[]): AttachmentFile[] {
  const files = new Map(snapshot?.map(file => [file.filename, file]));
  return filenames.map(filename => {
    const observed = files.get(filename);
    if (!observed) throw new Error(`Lifecycle-provided attachment metadata is unavailable for #artifact/${id}/${filename}.`);
    return {...observed};
  });
}

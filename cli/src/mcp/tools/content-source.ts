import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

// File inputs are Markdown payloads, resolved before callers make any writes.
// Undefined preserves omission; an empty string or file supplies empty content.
export function resolveMarkdownSource(
  inline: string | undefined,
  file: string | undefined,
  field: 'body' | 'content',
): string | undefined {
  const fileField = `${field}_file`;
  if (inline !== undefined && file !== undefined) {
    throw new Error(`Provide either ${field} or ${fileField}, not both.`);
  }
  if (file === undefined) return inline;
  if (!isAbsolute(file)) throw new Error(`${fileField} must be an absolute path.`);

  let fd: number | undefined;
  try {
    // A FIFO must not block the tool before we can reject it as a non-file.
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw new Error('expected a regular file');
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readFileSync(fd));
  } catch (err) {
    throw new Error(`Cannot read ${fileField} "${file}": ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

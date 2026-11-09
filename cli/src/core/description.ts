// The index format is one line per field, so a description is single-line by
// definition: embedded newlines collapse to spaces. The single statement of the
// rule — the Store applies it wherever a description enters an index.
export function oneLineDescription(description: string): string {
  return description.replace(/\r\n|[\r\n]/g, ' ');
}

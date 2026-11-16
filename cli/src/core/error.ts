// Anything can be thrown: report an Error by its message and the rest as text.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

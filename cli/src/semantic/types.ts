/** A completed index generation published by instance lifecycle maintenance. */
export interface SemanticIndexSnapshot {
  sourceVersion: string;
  model: string;
  indexedChunks: number;
}

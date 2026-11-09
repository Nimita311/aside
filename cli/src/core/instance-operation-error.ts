/** Neutral owner result; each interface supplies its own recovery command. */
export class InstanceOperationError extends Error {
  constructor(readonly reason: 'NOT_INSTANCE' | 'ALREADY_INSTANCE', message: string) {
    super(message);
  }
}

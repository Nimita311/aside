// Mutation receipts describe confirmed durable effects, independently of the
// response selection or a later failure. A journal belongs to one synchronous
// mutation; nested handlers share it so linked creates retain their results.
export interface MutationChange {
  kind: 'entry' | 'project' | 'action' | 'artifact' | 'instance' | 'attachment' | 'index' | 'recurrenceHistory' | 'file';
  id: string;
  effect: 'CREATED' | 'UPDATED' | 'REMOVED';
  path?: string;
  fields?: string[];
}
export interface MutationFailure {
  message: string;
  kind?: MutationChange['kind'];
  id?: string;
  path?: string;
  fields?: string[];
}
export interface MutationResult {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED';
  changes: MutationChange[];
  failures: MutationFailure[];
  recovery?: string;
}
interface Journal { changes: MutationChange[]; failures: MutationFailure[]; beforeWrite?: () => void }
const journals = new WeakMap<object, Journal>();
const recovery = 'Read the reported records and files before retrying. Preserve saved changes and retry only the incomplete steps; do not repeat a create that already saved its record.';

function snapshot(journal: Journal, failed = false): MutationResult {
  return {
    status: journal.failures.length || failed ? journal.changes.length ? 'PARTIAL' : 'FAILED' : 'SUCCEEDED',
    changes: structuredClone(journal.changes), failures: structuredClone(journal.failures),
    ...(journal.failures.length || failed ? { recovery } : {}),
  };
}

export class MutationWriteError extends Error {
  readonly originalMessage: string;
  constructor(error: unknown, readonly partialResult: MutationResult) {
    const message = error instanceof Error ? error.message : String(error);
    super(partialResult.changes.length
      ? `${message}\nSaved changes: ${JSON.stringify(partialResult.changes)}\nRecovery: ${partialResult.recovery}` : message, { cause: error });
    this.name = 'MutationWriteError';
    this.originalMessage = error instanceof MutationWriteError ? error.originalMessage : message;
  }
}

export function recordMutationChange(owner: object, change: MutationChange): void {
  const journal = journals.get(owner);
  if (!journal) return;
  const existing = journal.changes.find(item => item.kind === change.kind && item.id === change.id && item.path === change.path && item.effect === change.effect);
  if (existing) {
    if (change.fields) existing.fields = [...new Set([...(existing.fields ?? []), ...change.fields])];
  } else journal.changes.push(structuredClone(change));
}

export function recordMutationFailure(owner: object, failure: MutationFailure): void {
  journals.get(owner)?.failures.push(structuredClone(failure));
}

/** Defer linked creates until the owning handler finishes its write preflight. */
export function beforeMutationWrite(owner: object, action: () => void): () => void {
  const journal = journals.get(owner);
  if (!journal) throw new Error('A deferred mutation write requires an active mutation journal.');
  if (journal.beforeWrite) throw new Error('A deferred mutation write is already registered.');
  journal.beforeWrite = action;
  return () => {if (journal.beforeWrite === action) delete journal.beforeWrite;};
}

// Call only around the durable operation, and record only after it succeeds.
// Staging files and directories are not saved user records.
export function persistMutationWrite<T>(owner: object, change: MutationChange, write: () => T): T {
  const journal = journals.get(owner);
  const beforeWrite = journal?.beforeWrite;
  // Clear before invoking: the callback's own writes join this journal without
  // re-entering the hook. A failed owner preflight never invokes the callback.
  if (beforeWrite) {delete journal!.beforeWrite; beforeWrite();}
  try {
    const value = write();
    recordMutationChange(owner, change);
    return value;
  } catch (error) {
    const {effect: _effect, ...target} = change;
    recordMutationFailure(owner, { ...target, message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export function trackMutation<T>(owner: object, action: () => T): { value: T; result: MutationResult } {
  const existing = journals.get(owner);
  if (existing) return { value: action(), result: snapshot(existing) };
  const journal: Journal = { changes: [], failures: [] };
  journals.set(owner, journal);
  try { return { value: action(), result: snapshot(journal) }; }
  catch (error) {
    if (!journal.failures.length) recordMutationFailure(owner, { message: error instanceof Error ? error.message : String(error) });
    throw new MutationWriteError(error, snapshot(journal, true));
  } finally { journals.delete(owner); }
}

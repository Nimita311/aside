// Bound background file checks so they leave room for user-driven reads.
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/** Settle with `work`, or reject as soon as `signal` aborts; `work` itself keeps
 * running and its own late failure stays handled. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal, reason: () => unknown = () => signal.reason): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(reason());
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
  });
}

export interface RetryTimingOptions {
  debounceMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  reconciliationIntervalMs?: number;
}

/** Defaults, validation and capped exponential backoff shared by the lifecycle
 * owners; `invalid` is the owner's message for unusable intervals. */
export function retryTiming(options: RetryTimingOptions, invalid: string): {debounceMs: number; intervalMs: number; retryDelay: (failures: number) => number} {
  const debounceMs = options.debounceMs ?? 100, intervalMs = options.reconciliationIntervalMs ?? 60_000;
  const retryMinMs = options.retryMinMs ?? 1_000, retryMaxMs = options.retryMaxMs ?? 30_000;
  if (![intervalMs, debounceMs].every(value => Number.isSafeInteger(value) && value >= 0)
    || ![retryMinMs, retryMaxMs].every(value => Number.isSafeInteger(value) && value > 0)
    || retryMaxMs < retryMinMs) throw new Error(invalid);
  return {debounceMs, intervalMs,
    retryDelay: failures => Math.min(retryMaxMs, retryMinMs * 2 ** Math.min(Math.max(0, failures - 1), 30))};
}

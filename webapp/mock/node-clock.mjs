import { AsyncLocalStorage } from 'node:async_hooks';

// Injected into the Node fixture bundle only. Concurrent sessions retain their
// own query clock without replacing the server process's global Date.
const clock = new AsyncLocalStorage();
const SystemDate = globalThis.Date;
const timestamp = () => clock.getStore() ?? SystemDate.now();
export const Date = new Proxy(SystemDate, {
  construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [timestamp()], newTarget); },
  apply() { return new SystemDate(timestamp()).toString(); },
  get(target, property, receiver) { return property === 'now' ? timestamp : Reflect.get(target, property, receiver); },
});
export function withClock(now, work) {
  const instant = SystemDate.parse(now);
  if (!Number.isFinite(instant)) throw new Error('Invalid mock clock.');
  return clock.run(instant, work);
}

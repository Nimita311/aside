// Node 25+ defines `localStorage` and `sessionStorage` on globalThis as
// getters that read undefined without --localstorage-file, and the happy-dom
// environment leaves globals that already exist alone — so the DOM's storage
// never arrives and every test touching it fails. Where a storage global is
// present but undefined, install an in-memory Storage in its place.
import { beforeEach } from 'vitest';
class MemoryStorage implements Storage {
  [name: string]: unknown;
  private items = new Map<string, string>();
  get length(): number { return this.items.size; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.items.get(String(key)) ?? null; }
  setItem(key: string, value: string): void { this.items.set(String(key), String(value)); }
  removeItem(key: string): void { this.items.delete(String(key)); }
  clear(): void { this.items.clear(); }
}

// Browser fixtures represent a connected tab unless a test explicitly exercises
// missing or expired access. Production access is still checked by the server.
beforeEach(() => localStorage.setItem('aside.webToken', 'fixture-browser-token'));

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  if (descriptor && (globalThis as Record<string, unknown>)[name] === undefined) {
    Object.defineProperty(globalThis, name, { configurable: true, enumerable: true, value: new MemoryStorage() });
  }
}

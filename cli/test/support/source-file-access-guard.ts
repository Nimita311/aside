import {vi} from 'vitest';
import {AsyncLocalStorage} from 'node:async_hooks';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {constants, realpathSync} from 'node:fs';
import {managedInstancePathKind} from '../../src/core/managed-path.js';

// Import this helper before application modules. Calls are intercepted at the
// filesystem boundary, so a new raw fs call cannot evade a helper-level spy.
const hooks = vi.hoisted(() => ({
  check: undefined as undefined | ((method: string, args: unknown[]) => void),
  opened: undefined as undefined | ((fd: number, path: unknown) => void),
  closed: undefined as undefined | ((fd: number) => void),
  handle: undefined as undefined | ((handle: object, path: unknown) => object),
  iterator: undefined as undefined | ((iterator: object, method: string, args: unknown[]) => object),
}));

const mockedFilesystems = vi.hoisted(() => ({promises: undefined as Record<string, any> | undefined}));

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped: Record<string, any> = {};
  for (const [name, fn] of Object.entries(original)) {
    if (name === 'default') continue;
    if (typeof fn !== 'function') {wrapped[name] = fn; continue;}
    if (name === 'watch' || name === 'glob') {
      wrapped[name] = (...args: unknown[]) => {
        hooks.check?.(name, args);
        const iterator = (fn as (...args: any[]) => object)(...args);
        return hooks.iterator?.(iterator, name, args) ?? iterator;
      };
      continue;
    }
    wrapped[name] = async (...args: unknown[]) => {
      hooks.check?.(name, args);
      const result = await (fn as (...args: any[]) => any)(...args);
      return name === 'open' ? hooks.handle?.(result, args[0]) ?? result : result;
    };
  }
  mockedFilesystems.promises = wrapped;
  return {...wrapped, default: wrapped};
});

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  // The same facade covers named fs.promises, default fs.promises and direct
  // imports of node:fs/promises.
  const promises = await import('node:fs/promises');
  const wrapped: Record<string, any> = {};
  for (const [name, fn] of Object.entries(original)) {
    if (name === 'default' || name === 'promises') continue;
    if (typeof fn !== 'function' || /^[A-Z]/.test(name)) {wrapped[name] = fn; continue;}
    const run = (...args: unknown[]) => {
      hooks.check?.(name, args);
      if (name === 'open') {
        const callback = args.at(-1) as (...args: any[]) => void;
        args[args.length - 1] = (error: unknown, fd: number) => {
          if (!error) hooks.opened?.(fd, args[0]);
          callback(error, fd);
        };
      }
      const result = (fn as (...args: any[]) => any)(...args);
      if (name === 'openSync') hooks.opened?.(result, args[0]);
      if (name === 'close' || name === 'closeSync') hooks.closed?.(args[0] as number);
      return result;
    };
    // Node's containment helpers use realpathSync.native too.
    for (const key of Object.keys(fn)) if (typeof (fn as any)[key] === 'function') {
      (run as any)[key] = (...args: unknown[]) => {hooks.check?.(name, args); return (fn as any)[key](...args);};
    }
    wrapped[name] = run;
  }
  wrapped.promises = mockedFilesystems.promises ?? promises;
  return {...wrapped, default: wrapped};
});

export type SourceFileOperation = 'read' | 'write' | 'watch';
export interface SourceFileAccess {method: string; operation: SourceFileOperation; path: string}
export interface SourceFileException {
  paths: readonly string[];
  operations: readonly SourceFileOperation[];
  reason: string;
}

interface ScopedException extends SourceFileException {active: boolean}
const exceptions = new AsyncLocalStorage<readonly ScopedException[]>();
const descriptors = new Map<number, string>();
const violations: SourceFileAccess[] = [];
let roots: string[] = [];

function pathname(value: unknown): string | undefined {
  if (typeof value === 'number') return descriptors.get(value);
  if (value instanceof URL) return value.protocol === 'file:' ? resolve(fileURLToPath(value)) : undefined;
  if (typeof value === 'string' || Buffer.isBuffer(value)) return resolve(value.toString());
  // Generic fs.promises functions accept FileHandles as well as paths. Those
  // calls use native internals rather than the handle's public read/write methods.
  if (value && typeof value === 'object' && typeof (value as {fd?: unknown}).fd === 'number') {
    return descriptors.get((value as {fd: number}).fd);
  }
}

const isPath = (value: unknown) => typeof value === 'string' || Buffer.isBuffer(value) || value instanceof URL;

const readMethods = new Set(['access', 'exists', 'stat', 'lstat', 'fstat', 'realpath', 'readlink', 'readFile', 'readdir', 'opendir', 'read', 'readv', 'createReadStream', 'readLines', 'readableWebStream', 'openAsBlob']);
const writeMethods = new Set(['writeFile', 'appendFile', 'truncate', 'ftruncate', 'write', 'writev', 'chmod', 'fchmod', 'lchmod', 'chown', 'fchown', 'lchown', 'utimes', 'futimes', 'lutimes', 'mkdir', 'mkdtemp', 'unlink', 'rm', 'rmdir', 'createWriteStream', 'fsync', 'fdatasync']);
const rootMethods = new Set(['readdir', 'opendir', 'glob', 'watch', 'watchFile', ...writeMethods, 'rename', 'cp', 'copyFile', 'link', 'symlink']);

function protectedPath(path: string, method: string): boolean {
  return roots.some(root => {
    const child = relative(root, path);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return false;
    if (!child) return rootMethods.has(method);
    return child.toLowerCase() === '.aside' || managedInstancePathKind(child) !== undefined;
  });
}

function access(method: string, operation: SourceFileOperation, value: unknown): void {
  const path = pathname(value);
  if (!path || !protectedPath(path, method)) return;
  if (exceptions.getStore()?.some(exception => exception.active && exception.paths.includes(path) && exception.operations.includes(operation))) return;
  const violation = {method, operation, path};
  violations.push(violation);
  throw new Error(`Lifecycle ownership violation: ${method} attempted to ${operation} ${path}`);
}

function openOperations(flags: unknown): SourceFileOperation[] {
  if (typeof flags === 'string') return [...(flags.includes('r') || flags.includes('+') ? ['read' as const] : []),
    ...(/[wa+]/.test(flags) ? ['write' as const] : [])];
  // Node O_ACCMODE is the low two bits; O_RDONLY is zero.
  const mode = typeof flags === 'number' ? flags & 3 : 0;
  const operations: SourceFileOperation[] = mode === 2 ? ['read', 'write'] : [mode === 1 ? 'write' : 'read'];
  if (typeof flags === 'number' && flags & (constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND) && !operations.includes('write')) operations.push('write');
  return operations;
}

hooks.check = (name, args) => {
  const method = name.replace(/Sync$/, '');
  if (method === 'glob') {
    const cwd = pathname((args[1] as {cwd?: unknown} | undefined)?.cwd) ?? process.cwd();
    for (const pattern of Array.isArray(args[0]) ? args[0] : [args[0]]) {
      if (typeof pattern !== 'string') continue;
      const magic = pattern.split('').findIndex(character => '*?{[('.includes(character));
      const prefix = magic === -1 ? pattern : pattern.slice(0, magic);
      const base = magic === -1 || prefix.endsWith(sep) ? prefix : dirname(prefix);
      access(method, 'read', resolve(cwd, base));
    }
    return;
  }
  if (method === 'open') {for (const operation of openOperations(args[1])) access(method, operation, args[0]); return;}
  if (method === 'rename') {access(method, 'write', args[0]); access(method, 'write', args[1]); return;}
  if (['cp', 'copyFile', 'link'].includes(method)) {access(method, 'read', args[0]); access(method, 'write', args[1]); return;}
  if (method === 'symlink') {access(method, 'write', args[1]); return;}
  if (method === 'watch' || method === 'watchFile') {access(method, 'watch', args[0]); return;}
  if (method === 'readFile' || method === 'createReadStream' || method === 'readLines') {
    const options = args[1] && typeof args[1] === 'object' ? args[1] as {fd?: unknown; flag?: unknown; flags?: unknown} : undefined;
    // A supplied descriptor replaces the path for streams. Existing handles
    // ignore open flags; path-opening reads can still truncate/create a file.
    const target = method === 'createReadStream' && options?.fd != null ? options.fd : args[0];
    access(method, 'read', target);
    if (isPath(target)) {
      const flags = method === 'readFile' ? options?.flag : options?.flags;
      if (flags !== undefined && openOperations(flags).includes('write')) access(method, 'write', target);
    }
    return;
  }
  if (method === 'createWriteStream') {
    const descriptor = (args[1] as {fd?: unknown} | undefined)?.fd;
    access(method, 'write', descriptor != null ? descriptor : args[0]);
    return;
  }
  if (readMethods.has(method)) access(method, 'read', args[0]);
  if (writeMethods.has(method)) access(method, 'write', args[0]);
};
hooks.opened = (fd, path) => {const resolved = pathname(path); if (resolved) descriptors.set(fd, resolved);};
hooks.closed = fd => {descriptors.delete(fd);};
hooks.iterator = (iterator, method, args) => {
  const proxy = new Proxy(iterator, {get(target, property) {
    if (property === Symbol.asyncIterator) return () => proxy;
    const value = Reflect.get(target, property, target);
    if (typeof value !== 'function') return value;
    if (property !== 'next') return value.bind(target);
    return (...nextArgs: unknown[]) => {
      try {hooks.check?.(method, args); return value.apply(target, nextArgs);}
      catch (error) {return Promise.reject(error);}
    };
  }});
  return proxy;
};
hooks.handle = (handle, input) => {
  const path = pathname(input);
  if (!path) return handle;
  hooks.opened?.((handle as {fd: number}).fd, path);
  return new Proxy(handle, {get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== 'function') return value;
    const invoke = (...args: unknown[]) => {
      const method = String(property);
      if (method === 'close') hooks.closed?.((target as {fd: number}).fd);
      else hooks.check?.(method, [target, ...args]);
      return value.apply(target, args);
    };
    return ['createReadStream', 'createWriteStream', 'readLines', 'readableWebStream'].includes(String(property))
      ? invoke : async (...args: unknown[]) => invoke(...args);
  }});
};

export const sourceFileAccessGuard = {
  protect(paths: readonly string[]): void {
    roots = [];
    roots = [...new Set(paths.flatMap(path => {
      const absolute = resolve(path);
      try {return [absolute, realpathSync(absolute)];} catch {return [absolute];}
    }))];
    violations.length = 0;
  },
  reset(): void {roots = []; violations.length = 0;},
  get violations(): readonly SourceFileAccess[] {return violations;},
  allow<T>(exception: SourceFileException, run: () => T): T {
    if (!exception.reason.trim() || !exception.paths.length || !exception.operations.length
      || exception.operations.some(operation => !['read', 'write', 'watch'].includes(operation))) {
      throw new Error('Source-file exceptions require exact paths, operations, and a reason.');
    }
    const scoped = {...exception, paths: exception.paths.map(path => resolve(path)), operations: [...exception.operations], active: true};
    try {
      const value = exceptions.run([...(exceptions.getStore() ?? []), scoped], run);
      if (value && typeof (value as unknown as PromiseLike<unknown>).then === 'function') {
        return Promise.resolve(value).finally(() => {scoped.active = false;}) as T;
      }
      scoped.active = false;
      return value;
    } catch (error) {scoped.active = false; throw error;}
  },
};

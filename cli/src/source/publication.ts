// Values whose state lives in internal slots rather than enumerable keys.
const nativeValue = (value: object): boolean => value instanceof Date || ArrayBuffer.isView(value)
  || value instanceof ArrayBuffer || value instanceof SharedArrayBuffer || value instanceof RegExp;

// Native mutable values need their internal slots preserved. Binary copies use
// dedicated buffers: pooled Buffer backing stores could otherwise alias a
// private template when a caller writes beyond the returned slice.
function detached(value: any, seen = new WeakMap<object, any>()): any {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  let result: any;
  if (value instanceof Date) result = new Date(value.getTime());
  else if (Buffer.isBuffer(value)) {
    const bytes = new Uint8Array(value.length); bytes.set(value); result = Buffer.from(bytes.buffer);
  } else if (value instanceof DataView) result = new DataView(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  else if (ArrayBuffer.isView(value)) result = new (value.constructor as any)(value);
  else if (value instanceof ArrayBuffer) result = value.slice(0);
  else if (value instanceof SharedArrayBuffer) {
    result = new SharedArrayBuffer(value.byteLength); new Uint8Array(result).set(new Uint8Array(value));
  } else if (value instanceof RegExp) {result = new RegExp(value.source, value.flags); result.lastIndex = value.lastIndex;}
  else result = value instanceof Map ? new Map() : value instanceof Set ? new Set()
    : Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
  seen.set(value, result);
  if (value instanceof Map) for (const [key, item] of value) result.set(detached(key, seen), detached(item, seen));
  else if (value instanceof Set) for (const item of value) result.add(detached(item, seen));
  else if (!nativeValue(value))
    for (const key of Object.keys(value)) Object.defineProperty(result, key, {
      value: detached(value[key], seen), enumerable: true, writable: true, configurable: true,
    });
  return result;
}

/** A detached owner generation. Ordinary data is frozen and cached; native
 * mutable fields return independent copies so their built-in APIs still work. */
export function publishReadonly<T>(source: T, protectedCollections?: ReadonlySet<object>): T {return publication(source, protectedCollections);}

/** Transport snapshots also copy rare native collections on access, keeping
 * structuredClone/postMessage compatible without exposing their cached state. */
export function publishTransportSnapshot<T>(source: T): T {return publication(source, new Set());}

function publication<T>(source: T, protectedCollections?: ReadonlySet<object>): T {
  const copies = new WeakMap<object, unknown>();
  const defensive = new WeakMap<object, () => any>();
  const exposed = new WeakMap<object, object>();
  const reject = () => {throw new TypeError('Published instance state is read-only. Use lifecycle mutations.');};
  const read = (value: any): any => {
    const factory = value !== null && typeof value === 'object' ? defensive.get(value) : undefined;
    if (!factory) return value;
    const result = factory(); exposed.set(result, value); return result;
  };
  const keyFor = (key: any): any => key !== null && typeof key === 'object' ? exposed.get(key) ?? key : key;
  const copy = (value: any): any => {
    if (value === null || typeof value !== 'object') return value;
    const saved = copies.get(value);
    if (saved) return saved;
    if (nativeValue(value)
      || protectedCollections && !protectedCollections.has(value) && (value instanceof Map || value instanceof Set)) {
      const template = detached(value), slot = Object.freeze({});
      copies.set(value, slot); defensive.set(slot, () => detached(template));
      return slot;
    }
    if (value instanceof Map) {
      const target = new Map();
      const view = new Proxy(target, {
        get(map, key, receiver) {
          if (key === 'set' || key === 'delete' || key === 'clear') return reject;
          if (key === 'forEach') return (callback: (value: unknown, key: unknown, map: unknown) => void, thisArg?: unknown) =>
            map.forEach((item, id) => callback.call(thisArg, read(item), read(id), view));
          if (key === 'size') return map.size;
          if (key === 'get') return (id: unknown) => read(map.get(keyFor(id)));
          if (key === 'has') return (id: unknown) => map.has(keyFor(id));
          if (key === 'entries' || key === Symbol.iterator) return function* () {for (const [id, item] of map) yield [read(id), read(item)];};
          if (key === 'keys') return function* () {for (const id of map.keys()) yield read(id);};
          if (key === 'values') return function* () {for (const item of map.values()) yield read(item);};
          return Reflect.get(map, key, receiver);
        },
      });
      copies.set(value, view);
      for (const [key, item] of value) target.set(copy(key), copy(item));
      return Object.freeze(view);
    }
    if (value instanceof Set) {
      const target = new Set();
      const view = new Proxy(target, {
        get(set, key, receiver) {
          if (key === 'add' || key === 'delete' || key === 'clear') return reject;
          if (key === 'forEach') return (callback: (value: unknown, key: unknown, set: unknown) => void, thisArg?: unknown) =>
            set.forEach(item => {const exposedItem = read(item); callback.call(thisArg, exposedItem, exposedItem, view);});
          if (key === 'size') return set.size;
          if (key === 'has') return (item: unknown) => set.has(keyFor(item));
          if (key === 'entries') return function* () {for (const item of set) {const exposedItem = read(item); yield [exposedItem, exposedItem];}};
          if (key === 'keys' || key === 'values' || key === Symbol.iterator) return function* () {for (const item of set) yield read(item);};
          return Reflect.get(set, key, receiver);
        },
      });
      copies.set(value, view);
      for (const item of value) target.add(copy(item));
      return Object.freeze(view);
    }
    const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
    copies.set(value, result);
    for (const key of Object.keys(value)) {
      const item = copy(value[key]);
      Object.defineProperty(result, key, defensive.has(item)
        ? {get: () => read(item), enumerable: true, configurable: true}
        : {value: item, enumerable: true, writable: true, configurable: true});
    }
    return Object.freeze(result);
  };
  return read(copy(source));
}

// One DNS label. Browser addresses may add a directory suffix; calendar
// markers always use this durable ID, unchanged when a name is edited.
export function isInstanceId(id: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(id);
}

export const INSTANCE_ID_RULE = 'id must be 1–63 lowercase ASCII letters, digits, or hyphens, starting and ending with a letter or digit';

// Browser addresses may have a directory hash; calendar identities never do.
export function isInstanceAddress(address: string): boolean {
  const parts = address.split('~');
  return isInstanceId(parts[0]) && (parts.length === 1 || (parts.length === 2 && /^[a-f0-9]{16}$/.test(parts[1])));
}

export function createInstanceId(name: string): string {
  const slug = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 63).replace(/-+$/g, '');
  return slug || `aside-${crypto.randomUUID()}`;
}

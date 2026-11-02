import { readFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { parseManifest, parseConfig, splitFrontMatter } from './parser.js';
import { readManagedText } from './managed-path.js';
import type { Manifest, AsideConfig, ParseResult, ParseIssue, InstanceRecord } from './types.js';

// The manifest file marks a directory as an aside instance and describes it.
export const MANIFEST_FILE = 'aside.md';
// The config file (control plane) lists instances and a default. It lives
// outside data directories; execution settings may also live at an instance root.
const CONFIG_FILE = '.aside';

// Local CLI checks use this to request registry cleanup after an actual failed
// instance selection, without treating syntax errors as instance operations.
export class InstancePathError extends Error {}

// A directory is an aside instance iff it has an `aside.md` manifest that
// begins with YAML front matter. This is a cheap heuristic — it checks for the
// opening `---` fence, not that the front matter is well-formed — enough to
// reject an unrelated prose file named `aside.md` while still accepting an
// empty manifest. It is the single definition of validity, shared by
// discovery, resolution, select_instance, and validate, so they cannot disagree.
export function isAsideDir(dir: string): boolean {
  const path = resolve(dir, MANIFEST_FILE);
  try {
    return readManagedText(dir, path).trimStart().startsWith('---');
  } catch {
    return false;
  }
}

// The empty/default manifest — the single source for "no valid manifest". `id`
// is required, so even the empty form carries it as the missing-field sentinel.
export function emptyManifest(): Manifest {
  return { id: '' };
}

// Read a directory's manifest with its parse issues, best-effort. An absent file
// yields the empty manifest; read failures also report the original cause and
// recovery. The one manifest reader; both `readManifest` and the Store use it.
export function readInstanceRecordResult(dir: string): ParseResult<InstanceRecord> {
  const path = resolve(dir, MANIFEST_FILE);
  try {
    const content = readManagedText(dir, path);
    const parsed = parseManifest(content);
    return { value: { manifest: parsed.value, body: splitFrontMatter(content).body.trim() }, issues: parsed.issues };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: { manifest: emptyManifest(), body: '' }, issues: [] };
    return { value: { manifest: emptyManifest(), body: '' }, issues: [{
      severity: 'error', code: 'read_error', file: MANIFEST_FILE,
      message: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}. Restore this manifest file or its read permissions, preserving its existing id, then retry. Calendar sync is disabled until it can be read.`,
    }] };
  }
}

export function readManifestResult(dir: string): ParseResult<Manifest> {
  const result = readInstanceRecordResult(dir);
  return { value: result.value.manifest, issues: result.issues };
}

// Read a directory's manifest value, best-effort (issues dropped).
export function readManifest(dir: string): Manifest {
  return readManifestResult(dir).value;
}

// Preserve internal identity guards while an established manifest cannot be
// read. Public listings and use still require isAsideDir; only a verified
// non-instance is removed from the persistent registry.
export function shouldRetainKnownInstance(dir: string): boolean {
  return isAsideDir(dir) || readManifestResult(dir).issues.some(issue => issue.code === 'read_error');
}

// Resolve a config path to absolute: expand a leading `~`, otherwise resolve
// relative to the directory holding the config. Always normalized (no trailing
// slash) — the result becomes an instance's identity key, and `show`'s asset
// containment check prefixes it with a separator.
function resolvePath(base: string, p: string): string {
  if (p === '~' || p.startsWith('~/')) return resolve(join(homedir(), p.slice(1)));
  return isAbsolute(p) ? resolve(p) : resolve(base, p);
}

// Read the `.aside` config in `dir`, with pointers and default resolved to
// absolute paths. Never throws. Returns the config plus issues — read failures,
// malformed config and referrals that don't resolve to a valid instance —
// so callers can surface them, the same way file parse issues are surfaced.
export function readConfig(dir: string): ParseResult<AsideConfig> {
  const path = join(dir, CONFIG_FILE);
  let parsed: ParseResult<AsideConfig>;
  try {
    parsed = parseConfig(readFileSync(path, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: {}, issues: [] };
    return { value: {}, issues: [{
      severity: 'error', code: 'read_error', file: CONFIG_FILE,
      message: `Could not read .aside: ${error instanceof Error ? error.message : String(error)}. Configuration was not applied. Repair the file or its permissions, then restart this agent session.`,
    }] };
  }
  const issues: ParseIssue[] = parsed.issues.map((i) => ({ ...i, file: CONFIG_FILE }));
  const value: AsideConfig = {};
  if (parsed.value.pointers) {
    value.pointers = parsed.value.pointers.map((p) => resolvePath(dir, p));
    for (const p of value.pointers) {
      if (!isAsideDir(p)) {
        issues.push({ severity: 'warning', code: 'broken_pointer', message: `Config pointer is not an aside instance: ${p}`, file: CONFIG_FILE });
      }
    }
  }
  if (parsed.value.default !== undefined) {
    value.default = resolvePath(dir, parsed.value.default);
    if (!isAsideDir(value.default)) {
      issues.push({ severity: 'warning', code: 'broken_default', message: `Config default is not an aside instance: ${value.default}`, file: CONFIG_FILE });
    }
  }
  if (parsed.value.execution !== undefined) value.execution = parsed.value.execution;
  if (parsed.value.discovery !== undefined) value.discovery = parsed.value.discovery;
  if (parsed.value.worktreeDetection !== undefined) value.worktreeDetection = parsed.value.worktreeDetection;
  return { value, issues };
}

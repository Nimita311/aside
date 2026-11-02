import { resolve } from 'node:path';
import { parseCommand, type CommandInput } from './options.js';
import { readdirSync } from 'node:fs';
import { startServer } from '../mcp/server.js';
import { isAsideDir, readConfig, InstancePathError } from '../core/instance.js';
import { instanceKey } from '../daemon/host.js';
import type { ParseIssue } from '../core/types.js';

function unique(xs: string[]): string[] {
  return Array.from(new Set(xs.map(instanceKey)));
}

// Structural discovery: $PWD and its immediate children that are aside
// instances (have an `aside.md` manifest).
function discoverDirs(cwd: string): string[] {
  const found: string[] = [];
  if (isAsideDir(cwd)) found.push(cwd);
  try {
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      if (entry.isDirectory() && isAsideDir(resolve(cwd, entry.name))) {
        found.push(resolve(cwd, entry.name));
      }
    }
  } catch {}
  return found;
}

export interface DirResolution {
  dataDir: string | null;
  candidates: string[];
  configIssues: ParseIssue[];
  invalidDir?: string;
  // Whether structural discovery ran. False only when the config sets
  // `discovery: false`; the server uses it to explain an empty instance list.
  discovery: boolean;
}

// Steps 1-2 of the directory flow: discover, then auto-select. Candidates are
// the union of structurally discovered instances and the `.aside` config's
// pointers/default that are valid instances, deduplicated by canonical path.
// A directory is auto-selected in precedence order: an explicit --dir, then
// the config default, then $PWD
// itself, then a sole candidate. Zero or multiple candidates leave none active
// — the agent selects one via selectInstance (select_instance in legacy mode).
// Step 3, tracking the encountered set across the session, lives in InstanceRegistry.
//
// `discovery: false` in the config turns off the structural scan: $PWD and its
// children are no longer scanned for candidates, and the $PWD-is-an-instance
// auto-select is skipped, so instances come purely from pointers/default. An
// explicit --dir is not discovery and still works.
export function resolveDataDir(cwd: string, args: CommandInput): DirResolution {
  const dirArg = parseCommand('mcp', args).get('--dir');
  const { value: config, issues: configIssues } = readConfig(cwd);
  const discovery = config.discovery ?? true;
  const candidates = unique([
    ...(discovery ? discoverDirs(cwd) : []),
    ...(config.pointers ?? []).filter(isAsideDir),
    ...(config.default && isAsideDir(config.default) ? [config.default] : []),
  ]);

  if (dirArg !== undefined) {
    const dir = resolve(cwd, dirArg);
    if (isAsideDir(dir)) return { dataDir: instanceKey(dir), candidates: unique([...candidates, dir]), configIssues, discovery };
    return { dataDir: null, candidates, configIssues, invalidDir: dir, discovery };
  }

  if (config.default && isAsideDir(config.default)) return { dataDir: instanceKey(config.default), candidates, configIssues, discovery };
  if (discovery && isAsideDir(cwd)) return { dataDir: instanceKey(cwd), candidates, configIssues, discovery };
  if (candidates.length === 1) return { dataDir: candidates[0], candidates, configIssues, discovery };
  return { dataDir: null, candidates, configIssues, discovery };
}

export async function runMcp(args: CommandInput): Promise<void> {
  const parsed = parseCommand('mcp', args);
  if (parsed.helpText) { console.log(parsed.helpText); return; }
  const { dataDir, candidates, configIssues, invalidDir, discovery } = resolveDataDir(process.cwd(), parsed);
  if (invalidDir) {
    throw new InstancePathError(`Not an aside directory (no aside.md manifest): ${invalidDir}`);
  }
  await startServer(dataDir, candidates, configIssues, discovery, undefined, { graphql: !parsed.has('--legacy') });
}

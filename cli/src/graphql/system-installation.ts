import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, opendirSync, readSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defaultPluginContext, inspectPluginStatus, type ClaudeState, type CodexState, type PluginContext, type Runner } from '../commands/plugin.js';
import type { HealthCheck } from '../commands/output.js';
import { abortable } from '../core/async.js';
import { errorMessage } from '../core/error.js';

export interface SystemInstallationSnapshot {
  checkout: string | null;
  information: Array<{ group: string; name: string; value: string | null }>;
  checks: Array<HealthCheck & { problems: string[]; fixes: string[] }>;
  agents: Array<{
    name: 'claude' | 'codex';
    path: string | null;
    claude: ClaudeState | null;
    codex: CodexState | null;
  }>;
}

export interface SystemInstallationOptions {
  signal?: AbortSignal;
  cwd?: string;
  /** Test seam; production inspects the same checkout and registrations as plugin status. */
  context?: PluginContext;
  timeoutMs?: number;
}

function statusRunner(signal: AbortSignal): Runner {
  return (command, args, options) => new Promise((resolve) => {
    execFile(command, args, {cwd: options?.cwd, signal, maxBuffer: 16 * 1024 * 1024}, (error, stdout, stderr) => {
      const code = error ? (typeof (error as {code?: unknown}).code === 'number' ? (error as {code: number}).code : 1) : 0;
      resolve({code, stdout: String(stdout), stderr: String(stderr || error?.message || '')});
    });
  });
}

function boundedTree(signal: AbortSignal, deadline: number): NonNullable<PluginContext['readTree']> {
  let entries = 0, bytes = 0;
  const maxEntries = 2_000, maxBytes = 8 * 1024 * 1024, maxDepth = 32;
  const check = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Installation file inspection timed out.');
  };
  return directory => {
    const files = new Map<string, Buffer>(), ancestors = new Set<string>();
    const visit = (directory: string, prefix: string, depth: number) => {
      check();
      if (depth > maxDepth) throw new Error('Plugin file inspection exceeded its directory depth limit.');
      let canonical: string;
      try { canonical = realpathSync(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (ancestors.has(canonical)) throw new Error('Plugin file inspection found a symbolic-link cycle.');
      ancestors.add(canonical);
      const opened = opendirSync(directory);
      try {
        for (let entry = opened.readSync(); entry; entry = opened.readSync()) {
          check();
          if (entry.name === '.DS_Store') continue;
          if (++entries > maxEntries) throw new Error('Plugin file inspection exceeded its file count limit.');
          const path = join(directory, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (statSync(path).isDirectory()) { visit(path, relative, depth + 1); continue; }
          const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
          try {
            const stat = fstatSync(fd);
            if (!stat.isFile()) throw new Error('Plugin file inspection encountered a non-regular file.');
            if (stat.size > maxBytes - bytes) throw new Error('Plugin file inspection exceeded its byte limit.');
            const buffer = Buffer.allocUnsafe(stat.size + 1);
            let length = 0;
            while (length < buffer.length) {
              check();
              const read = readSync(fd, buffer, length, buffer.length - length, null);
              if (!read) break;
              length += read;
            }
            if (length > stat.size) throw new Error('Plugin file changed during installation inspection.');
            bytes += length;
            files.set(relative, buffer.subarray(0, length));
          } finally { closeSync(fd); }
        }
      } finally { opened.closeSync(); ancestors.delete(canonical); }
    };
    visit(directory, '', 0);
    return files;
  };
}

/** Inspect already-exposed installation diagnostics without installation or agent inference. */
export async function collectSystemInstallation(options: SystemInstallationOptions = {}): Promise<SystemInstallationSnapshot> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const checks = (items: HealthCheck[]) => items.map(check => ({...check, problems: check.problems ?? [], fixes: check.fixes ?? []}));
  let context: PluginContext;
  try {
    const original = options.context ?? defaultPluginContext();
    context = {...original, cwd: options.cwd ?? original.cwd};
  }
  catch (error) {
    return {checkout: null, information: [], agents: [], checks: checks([
      {code: 'plugin_operation', label: 'Plugin status', passed: false, problems: [errorMessage(error)]},
    ])};
  }
  const runner = options.context?.runner ?? statusRunner(signal);
  const snapshot = await inspectPluginStatus({...context, out: () => {}, readTree: boundedTree(signal, deadline), runner: (command, args, input) => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('Installation status inspection timed out.');
    return abortable(runner(command, args, {...input, cwd: input?.cwd ?? context.cwd}), signal);
  }});
  options.signal?.throwIfAborted();
  const information = snapshot.information.flatMap(section => Object.entries(section.fields ?? {}).map(([name, value]) =>
    ({group: section.name, name, value: value === null || value === undefined ? null : String(value)})));
  return {checkout: snapshot.checkout, information, checks: checks(snapshot.checks),
    agents: (['claude', 'codex'] as const).map(name => ({name,
      path: information.find(item => item.group === (name === 'claude' ? 'Claude Code' : 'Codex') && item.name === 'CLI')?.value ?? null,
      claude: name === 'claude' ? snapshot.agents.claude ?? null : null,
      codex: name === 'codex' ? snapshot.agents.codex ?? null : null,
    }))};
}

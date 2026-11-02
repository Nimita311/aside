import { LAUNCHCTL_TIMEOUT_MS, LAUNCHCTL_RETRY_MS } from '../core/system-config.js';
// The login job: a launchd agent Aside owns that starts the daemon at login
// (see design/daemon.md, Login job). macOS only.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { JOB_LABEL, type DaemonPaths } from './paths.js';

export interface Job {
  // node, the bundle, then its arguments.
  program: string[];
  // The build that wrote the job.
  builtAt: number;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function unxml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// The job runs the daemon in the foreground so launchd supervises the daemon
// itself, and restarts it after a crash but not after a clean exit.
export function renderJob(node: string, script: string, builtAt: number, log: string, homeOverride?: string | null): string {
  const program = [node, script, 'daemon', 'start', '--foreground'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${JOB_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
${program.map((arg) => `		<string>${xml(arg)}</string>`).join('\n')}
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>ASIDE_JOB_BUILT_AT</key>
		<string>${builtAt}</string>
${homeOverride ? `\t\t<key>ASIDE_DAEMON_HOME</key>\n\t\t<string>${xml(homeOverride)}</string>\n` : ''}\t</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>StandardOutPath</key>
	<string>${xml(log)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(log)}</string>
</dict>
</plist>
`;
}

// Read back a job this module wrote; null when none is installed or it is not
// one of ours.
export function readJob(paths: DaemonPaths): Job | null {
  if (!paths.job || !existsSync(paths.job)) return null;
  try {
    const text = readFileSync(paths.job, 'utf8');
    const array = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    if (!array) return null;
    const program = [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]));
    const at = program.indexOf('--foreground');
    if (at === -1) return null;
    const rest = program.slice(at + 1);
    // Recognize obsolete instance arguments in previously installed jobs.
    const selected: string[] = [];
    let all = false;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--all') all = true;
      else if (arg === '--dir') {
        const path = rest[++i];
        if (!path || path.startsWith('-')) return null;
        selected.push(path);
      } else if (arg.startsWith('--dir=')) {
        const path = arg.slice('--dir='.length);
        if (!path) return null;
        selected.push(path);
      } else if (arg.startsWith('-') || !arg) return null;
      else selected.push(arg);
    }
    if (all && selected.length) return null;
    const built = text.match(/<key>ASIDE_JOB_BUILT_AT<\/key>\s*<string>(\d+)<\/string>/);
    return {
      program,
      builtAt: built ? Number(built[1]) : 0,
    };
  } catch {
    return null;
  }
}

export function writeJob(paths: DaemonPaths, node: string, script: string, builtAt: number): void {
  if (!paths.job) throw new Error('The login job needs launchd, which is only available on macOS.');
  mkdirSync(dirname(paths.job), { recursive: true });
  const tmp = `${paths.job}.${process.pid}.tmp`;
  writeFileSync(tmp, renderJob(node, script, builtAt, paths.log, paths.homeOverride));
  renameSync(tmp, paths.job);
}

export function removeJob(paths: DaemonPaths): boolean {
  if (!paths.job || !existsSync(paths.job)) return false;
  unlinkSync(paths.job);
  return true;
}

function launchctl(args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((done) => {
    execFile('launchctl', args, { timeout: LAUNCHCTL_TIMEOUT_MS }, (err, stdout, stderr) => {
      done({ ok: !err, output: `${stdout}${stderr}`.trim() });
    });
  });
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

// (Re)load the job from its file. launchd starts it at once (RunAtLoad).
export async function loadJob(paths: DaemonPaths): Promise<void> {
  await launchctl(['bootout', `${domain()}/${JOB_LABEL}`]); // not loaded is fine
  // launchd may still be tearing the old job down; give it a few tries.
  let result = await launchctl(['bootstrap', domain(), paths.job!]);
  for (let attempt = 0; !result.ok && attempt < 5; attempt++) {
    await new Promise((r) => setTimeout(r, LAUNCHCTL_RETRY_MS));
    result = await launchctl(['bootstrap', domain(), paths.job!]);
  }
  if (!result.ok) throw new Error(`launchctl could not load the login job: ${result.output}`);
}

// Start the loaded job now, loading it first when launchd does not have it.
export async function startJob(paths: DaemonPaths): Promise<void> {
  const started = await launchctl(['kickstart', `${domain()}/${JOB_LABEL}`]);
  if (!started.ok) await loadJob(paths);
}

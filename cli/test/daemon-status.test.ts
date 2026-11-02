import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { formatDaemonStatus } from '../src/commands/daemon-status.js';
import { daemonPaths } from '../src/daemon/paths.js';
import type { Status } from '../src/daemon/protocol.js';

describe('daemon status checklist', () => {
  let root: string;
  let work: string;
  let personal: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync('/tmp/aside-status-'));
    work = join(root, 'work');
    personal = join(root, 'personal');
    init(work, { name: 'Work', description: 'Work records' });
    init(personal, { name: 'Personal', description: 'Personal records' });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });
  function report(overrides: Partial<Parameters<typeof formatDaemonStatus>[0]> = {}) {
    return formatDaemonStatus({ paths: { ...daemonPaths({ ASIDE_DAEMON_HOME: root }), job: join(root, 'job.plist') },
      unavailable: false, known: [work, personal], job: null, jobFileExists: false, ...overrides });
  }
  function running(overrides: Partial<Status> = {}): Status {
    return { pid: 123, build: { version: '0.1.0', builtAt: Date.UTC(2026, 9, 5) }, connections: 3, tabs: 1, known: [work, personal], loaded: [work, personal], ...overrides };
  }

  it('lists loaded instances and omits lifecycle selection output', () => {
    const { output, errors } = report({ running: running() });
    expect(errors).toBe(false);
    expect(output).toContain('[OK] Daemon connection');
    expect(output).toContain('2026-10-05T00:00:00.000Z');
    expect(output).toContain('Connected clients');
    expect(output).not.toContain('Background selection');
    expect(output).not.toContain('Login selection');
    expect(output).toContain('Work (loaded)');
    expect(output).toContain('Personal (loaded)');
    expect(output).toContain('Work (loaded)');
    expect(output).not.toContain('Personal (background)');
    expect(output.split('Health')[0]).toContain(personal);
    expect(output).not.toContain('Calendar sync:');
  });

  it('reports a running daemon without clients and a stopped daemon as normal', () => {
    const active = report({ running: running({ connections: 1 }) });
    expect(active.errors).toBe(false);
    expect(active.output).not.toContain('Background selection');
    expect(active.output).toMatch(/Connected clients\s+0/);
    expect(active.output).not.toContain('Background updates: selected');
    const stopped = report();
    expect(stopped.errors).toBe(false);
    expect(stopped.output).toContain('[OK] Daemon stopped (starts when needed)');
    
    expect(stopped.output).toContain('Login job  none');
    expect(stopped.output).toContain('Work\n');
    expect(stopped.output).not.toContain('Connected clients');
  });

  it('shows the saved login job without instance selection', () => {
    const { output, errors } = report({ running: running(), jobFileExists: true,
      job: { program: [], builtAt: 0 } });
    expect(errors).toBe(false);
    expect(output).toContain('Work (loaded)');
    expect(output).toContain('[OK] Login job file');
    expect(output).not.toContain('selection');
    expect(output).toContain(join(root, 'job.plist'));
    expect(output).not.toContain('supervised');
  });

  it('shows unloaded state without making it an instance health check', () => {
    const { output, errors } = report({ running: running({ loaded: [work] }) });
    expect(errors).toBe(false);
    expect(output).toContain(`Personal\n  ${personal}`);
    expect(output).not.toContain('Personal loading');
    expect(output).not.toContain('Personal manifest');
  });

  it('reports an unrecognized saved job as an error instead of disabled startup', () => {
    const { output, errors } = report({ jobFileExists: true });
    expect(errors).toBe(true);
    expect(output).toContain('[ERROR] Login job file');
    expect(output).toContain('Fix: aside daemon install');
    expect(output).not.toContain('[OK] Login job file');
  });

  it('reports unavailable login support and an empty registry without an error', () => {
    const paths = { ...daemonPaths({ ASIDE_DAEMON_HOME: root }), job: null };
    const { output, errors } = report({ paths, known: [] });
    expect(errors).toBe(false);
    expect(output).not.toContain('Login job file');
    expect(output).toContain('Instances');
    
    expect(output).not.toContain('Enable: aside daemon install');
  });

  it('labels saved state when unreachable and omits dependent runtime claims', () => {
    const { output, errors } = report({ unavailable: true });
    expect(errors).toBe(true);
    expect(output).toContain('[ERROR] Daemon connection');
    expect(output).toContain('retry aside daemon status');
    expect(output).toContain('Instances (saved registry)');
    expect(output).toContain('Work\n');
    expect(output).not.toContain('Background updates:');
    expect(output).not.toContain('not loaded');
    expect(output).not.toContain('stopped');
  });

  it('reports each ID clash once with every affected path and leaves individual metadata to validation', () => {
    writeFileSync(join(work, 'aside.md'), '---\nid: shared\nname: Work\n---\n');
    writeFileSync(join(personal, 'aside.md'), '---\nid: shared\nname: Personal\n---\n');
    const duplicated = report({ running: running() });
    expect(duplicated.errors).toBe(true);
    expect(duplicated.output.match(/\[ERROR\] Instance ID clash: shared/g)).toHaveLength(1);
    const problem = duplicated.output.split('Problem:')[1];
    expect(problem).toContain(work);
    expect(problem).toContain(personal);
    expect(problem).toContain('aside instance forget --dir');
    expect(duplicated.output).not.toContain('Work manifest');
    const json = JSON.parse(formatDaemonStatus({ paths: daemonPaths({ ASIDE_DAEMON_HOME: root }),
      known: [work, personal], running: running(), unavailable: false, job: null, jobFileExists: false }, true).output);
    expect(json.ok).toBe(false);
    expect(json.checks.filter((check: { code: string }) => check.code.startsWith('instance_'))).toEqual([
      expect.objectContaining({ code: 'instance_id_conflict', passed: false }),
    ]);
    writeFileSync(join(personal, 'aside.md'), '---\nname: Personal\n---\n');
    const invalid = report();
    expect(invalid.errors).toBe(false);
    expect(invalid.output).toContain(`Personal\n  ${personal}`);
    expect(invalid.output).not.toContain('Personal manifest');
    expect(invalid.output).not.toContain('valid instance id');
  });

  it('includes clashes with a forgotten instance that remains loaded', () => {
    writeFileSync(join(personal, 'aside.md'), '---\nid: work\nname: Personal\n---\n');
    const { output, errors } = report({ known: [work], running: running({ known: [work] }) });
    expect(errors).toBe(true);
    expect(output).toContain('Instance ID clash: work');
    expect(output.split('Problem:')[1]).toContain(personal);
  });

  it('does not treat aliases of one directory as an ID clash', () => {
    const alias = join(root, 'alias');
    symlinkSync(work, alias);
    const { output, errors } = report({ known: [work, alias] });
    expect(errors).toBe(false);
    expect(output).not.toContain('Instance ID clash');
  });

  it('omits disappeared, repurposed, and unreadable paths even when listed as loaded', () => {
    rmSync(work, { recursive: true });
    const missing = report({ known: [work, personal], running: running({ loaded: [work] }) });
    expect(missing.output).not.toContain(`\n  ${work}`);
    writeFileSync(join(personal, 'aside.md'), 'Repurposed directory');
    expect(report().output).not.toContain(`\n  ${personal}`);
    rmSync(join(personal, 'aside.md')); mkdirSync(join(personal, 'aside.md'));
    expect(report().output).not.toContain(`\n  ${personal}`);
  });

  it('keeps manifest names and error text from impersonating checklist rows', () => {
    writeFileSync(join(work, 'aside.md'), '---\nid: work\nname: "Work\\n[OK] Fake"\n---\n');
    const { output, errors } = report({ known: [work] });
    expect(errors).toBe(false);
    expect(output).toContain('Work [OK] Fake');
    expect(output).not.toContain('\n[OK] Fake');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AutomationModelWarmup } from '../src/automation/model-warmup.js';
import { ModelCatalog, type ModelCatalogSnapshot } from '../src/automation/models.js';
import type { AutomationSource } from '../src/automation/scheduler.js';

let root: string, warmup: AutomationModelWarmup;
beforeEach(() => { root = realpathSync(mkdtempSync('/tmp/aside-model-warm-')); });
afterEach(async () => { await warmup?.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
const snapshot = (models: ModelCatalogSnapshot['models'] = [], diagnostics: string[] = []): ModelCatalogSnapshot => ({ models, diagnostics, revision: 'test' });
function source(key: string, run: unknown, extra: unknown = {}): AutomationSource {
  return { key, root, instance: 'work', definedIn: '#project/2026-10-08-work', declaration: { schedule: { cron: '0 8 * * *' }, run, ...(extra as object) } };
}
describe('model metadata warmup during automation ingestion', () => {
  it('skips script, custom-only, disabled, invalid and blocked work', () => {
    writeFileSync(join(root, '.aside'), 'execution:\n  models:\n    external:\n      command: third-agent\n');
    const lookup = vi.fn(async () => snapshot());
    warmup = new AutomationModelWarmup(() => {}, lookup);
    warmup.replace([
      source('script', { script: 'echo' }), source('external', { model: 'external', prompt: '#artifact/2026-10-08-instructions' }),
      source('disabled', { model: 'CODEX_TEST', prompt: '#artifact/2026-10-08-instructions' }, { enabled: false }),
      source('invalid', { model: '__reserved', prompt: '#artifact/2026-10-08-instructions' }),
      { ...source('blocked', { model: 'CODEX_TEST', prompt: '#artifact/2026-10-08-instructions' }), blocked: 'Duplicate identity' },
    ]);
    expect(lookup).not.toHaveBeenCalled(); expect(warmup.warnings()).toEqual([]);
  });
  it('starts metadata discovery without delaying ingestion, scopes warnings, and discards stale results', async () => {
    let resolve!: (value: ModelCatalogSnapshot) => void;
    const lookup = vi.fn(() => new Promise<ModelCatalogSnapshot>(done => { resolve = done; }));
    warmup = new AutomationModelWarmup(() => {}, lookup);
    warmup.replace([source('model', { model: 'CODEX_TEST', prompt: '#artifact/2026-10-08-instructions' }), source('script', { script: 'echo' })]);
    expect(lookup).toHaveBeenCalledOnce(); expect(warmup.warnings()).toEqual([]);
    resolve(snapshot([], ['codex: Authentication unavailable']));
    await vi.waitFor(() => expect(warmup.warnings()).toHaveLength(1));
    expect(warmup.warnings()[0]).toMatchObject({ root, key: 'model' });
    expect(warmup.warnings()[0].message).toContain('Authentication unavailable');
    warmup.replace([source('model', { model: 'CODEX_TEST', prompt: '#artifact/2026-10-08-instructions' })]);
    warmup.replace([source('script', { script: 'echo' })]);
    resolve(snapshot([], ['codex: New unavailable message']));
    await Promise.resolve(); await Promise.resolve();
    expect(warmup.warnings()).toEqual([]);
  });
  it('caches unsuccessful discovery under unchanged context instead of retrying on every ingestion', async () => {
    const executable = join(root, 'codex'); writeFileSync(executable, 'fake'); chmodSync(executable, 0o700);
    vi.stubEnv('PATH', root); vi.stubEnv('ASIDE_DAEMON_HOME', join(root, 'runtime'));
    const discover = vi.fn(async () => { throw new Error('Vendor temporarily unavailable'); });
    const catalog = new ModelCatalog({ discover });
    warmup = new AutomationModelWarmup(() => {}, (root, options) => catalog.for(root, options));
    const sources = [source('model', { model: 'CODEX_TEST', prompt: '#artifact/2026-10-08-instructions' })];
    warmup.replace(sources);
    await vi.waitFor(() => expect(warmup.warnings()).toHaveLength(1));
    warmup.replace(sources);
    await vi.waitFor(() => expect(warmup.warnings()).toHaveLength(1));
    expect(discover).toHaveBeenCalledOnce();
  });
  it('aborts pending discovery on shutdown and keeps completion from publishing warnings', async () => {
    const lookup = vi.fn((_root: string, options: { signal?: AbortSignal }) => new Promise<ModelCatalogSnapshot>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const changed = vi.fn(); warmup = new AutomationModelWarmup(changed, lookup);
    warmup.replace([source('model', { model: 'CODEX_TEST', prompt: '#artifact/2026-10-08-instructions' })]);
    changed.mockClear(); await warmup.close();
    expect(warmup.warnings()).toEqual([]); expect(changed).not.toHaveBeenCalled();
  });
});

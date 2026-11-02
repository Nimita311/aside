import { describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { AutomationController } from '../src/automation/controller.js';
import { RunStorage, type RunRecord } from '../src/automation/storage.js';

describe('scoped compiled automation inspection', () => {
  it('returns retained selected history before the legacy global inspection limit', async () => {
    const temporary = realpathSync(mkdtempSync('/tmp/aside-runtime-worker-'));
    const root = join(temporary, 'selected'), other = join(temporary, 'other'), storage = join(temporary, 'runs');
    const saved = new RunStorage(storage), controller = new AutomationController(storage);
    const record = (instance: string, id: string, started: string): RunRecord => ({
      id, key: JSON.stringify([instance, 'instance work', 'retained']), root: instance, definedIn: 'instance work',
      occurrence: started, started, finished: started, status: 'succeeded', session: 'previous', latenessMs: 0,
      definition: { schedule: { cron: '0 8 * * *', timezone: 'UTC' }, run: { script: 'echo' } },
    });
    try {
      saved.start(record(root, 'selected-old', '2026-10-09T08:00:00Z'));
      for (let index = 0; index < 205; index++) saved.start(record(other, `other-${index}`, '2026-10-10T08:00:00Z'));
      const declaration = record(root, 'declaration', '2026-10-10T08:00:00Z');
      // A blocked fixture starts only the inspection worker; it never runs a
      // subprocess, dispatches work, or performs model discovery.
      controller.replace(root, [{ key: declaration.key, root, definedIn: declaration.definedIn,
        instance: 'work', declaration: declaration.definition, blocked: 'Fixture execution blocked' }]);
      const scoped = await controller.inspect(root);
      expect(scoped.runs.map(run => run.id)).toEqual(['selected-old']);
      expect(scoped.jobs).toMatchObject([{ root, blocked: true, running: false, error: 'Fixture execution blocked' }]);
      const legacy = await controller.inspect();
      expect(legacy.runs).toHaveLength(200);
      expect(legacy.runs.some(run => run.id === 'selected-old')).toBe(false);
    } finally { await controller.close(); rmSync(temporary, { recursive: true, force: true }); }
  });
});

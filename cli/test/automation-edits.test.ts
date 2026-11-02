import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { handleUpdateProject } from '../src/mcp/tools/update.js';
import { handleUpdateInstance } from '../src/mcp/tools/instance.js';
import { applyAutomationEditsToMetadata, assertAutomationEdits, type AutomationEdits } from '../src/mcp/tools/automation-edits.js';

const task = (script: string) => ({schedule: {at: '2099-01-01T00:00:00Z'}, run: {script}});
it.each(['Literal instructions', {artifact: '#artifact/2026-10-08-instructions'}, '#artifact/2026-10-08-instructions/prompt.md', '#artifact/not-an-id'])('rejects invalid authored prompt patches before merging: %j', prompt => {
  expect(() => assertAutomationEdits({patch: {job: {run: {prompt}}}})).toThrow(/run.prompt/);
});
let dir: string, store: Store, project: string;
beforeEach(() => {
  dir = mkdtempSync('/tmp/aside-auto-edits-');
  init(dir, {name: 'Edits', description: 'Partial automation fixture', body: 'Keep instructions.'});
  store = new Store(dir);
  project = handleCapture(store, {content: 'Start', description: 'Start', projects: [{name: 'Notes', description: 'Notes', body: 'Keep project body.'}]}, new Date(2026, 9, 8, 12)).createdProjectIds[0];
});
afterEach(() => {store.close(); rmSync(dir, {recursive: true, force: true});});

for (const kind of ['project', 'instance'] as const) describe(`${kind} partial automation edits`, () => {
  const file = () => kind === 'project' ? store.getProjectFile(project)! : join(dir, 'aside.md');
  const write = (edits: AutomationEdits | null, body?: string) => kind === 'project'
    ? handleUpdateProject(store, {id: project, automationEdits: edits, body})
    : handleUpdateInstance(store, {automationEdits: edits, body});
  const jobs = () => kind === 'project' ? store.getProject(project)!.frontMatter.automations : store.getInstance()!.manifest.automations;
  function seed(metadata: string) {
    const original = readFileSync(file(), 'utf8');
    writeFileSync(file(), original.replace(/\n---(?=\n)/, `\n${metadata}\n---`));
    store.rebuild();
  }

  it('updates one job while preserving invalid siblings, retired models and custom YAML nodes', () => {
    seed(`automations:
  broken: {invalid: true} # keep malformed sibling
  retired:
    schedule: {at: '2099-01-01T00:00:00Z'}
    run: {model: retired_catalog_model, prompt: Old model} # preserve unavailable model
  edit:
    schedule: {at: '2099-01-01T00:00:00Z'}
    run: {script: old}
custom: &precise 9007199254740993123 # preserve precise scalar
copy: *precise`);
    write({upsert: {edit: task('new')}});
    expect(jobs()).toMatchObject({broken: {invalid: true}, retired: {run: {model: 'retired_catalog_model'}}, edit: task('new')});
    const saved = readFileSync(file(), 'utf8');
    expect(saved).toContain('broken: { invalid: true } # keep malformed sibling');
    expect(saved).toContain('# preserve unavailable model');
    expect(saved).toContain('9007199254740993123 # preserve precise scalar');
    expect(saved).toContain('copy: *precise');
    expect(saved).toContain(kind === 'project' ? 'Keep project body.' : 'Keep instructions.');
  });

  it('patches a retired model job by field and preserves nested YAML comments and unrelated jobs', () => {
    seed(`automations:
  retired:
    schedule:
      cron: '0 9 * * *' # keep authored cron
      timezone: America/Los_Angeles # keep authored zone
    run:
      model: RETIRED_GPT_MODEL # keep unavailable model
      prompt: "#artifact/2026-10-08-instructions" # keep instructions
    enabled: true
    timeout: PT1M
    overlap: skip
  broken: {invalid: true} # keep malformed sibling`);
    write({patch: {retired: {enabled: false, timeout: 'PT2M', schedule: {timezone: null}}}});
    expect(jobs()).toEqual({retired: {schedule: {cron: '0 9 * * *'}, run: {model: 'RETIRED_GPT_MODEL', prompt: '#artifact/2026-10-08-instructions'}, enabled: false, timeout: 'PT2M', overlap: 'skip'}, broken: {invalid: true}});
    const saved = readFileSync(file(), 'utf8');
    for (const comment of ['keep authored cron', 'keep unavailable model', 'keep instructions', 'keep malformed sibling']) expect(saved).toContain(comment);
    expect(saved).not.toContain('keep authored zone');
    write({patch: {retired: {enabled: null, timeout: null, overlap: null}}});
    expect(jobs()!.retired).toEqual({schedule: {cron: '0 9 * * *'}, run: {model: 'RETIRED_GPT_MODEL', prompt: '#artifact/2026-10-08-instructions'}});
  });

  it('merges nested fields and switches execution and schedule forms with explicit nulls', () => {
    seed(`automations:
  edit:
    schedule: {cron: '0 9 * * *', timezone: UTC}
    run: {model: RETIRED_GPT_MODEL, prompt: "#artifact/2026-10-08-instructions"}`);
    write({patch: {edit: {schedule: {cron: null, timezone: null, at: '2099-01-01T00:00:00Z'}, run: {model: null, prompt: null, script: 'echo', args: ['literal']}}}});
    expect(jobs()!.edit).toEqual({schedule: {at: '2099-01-01T00:00:00Z'}, run: {script: 'echo', args: ['literal']}});
    write({patch: {edit: {run: {args: null}}}});
    expect(jobs()!.edit).toEqual(task('echo'));
  });

  it('can repair missing required nested declarations with patches', () => {
    seed('automations:\n  edit: {enabled: false}');
    write({patch: {edit: {schedule: {at: '2099-01-01T00:00:00Z'}, run: {script: 'echo'}}}});
    expect(jobs()!.edit).toEqual({...task('echo'), enabled: false});
  });

  it('does not write any job when a patch target or merged definition is invalid', () => {
    seed('automations:\n  edit:\n    schedule: {at: "2099-01-01T00:00:00Z"}\n    run: {script: echo}');
    const original = readFileSync(file(), 'utf8');
    for (const patch of [{missing: {enabled: false}}, {edit: {run: {script: null}}}, {edit: {schedule: {cron: '0 9 * * *'}}}]) {
      expect(() => write({upsert: {new_job: task('new')}, patch}, 'Must not save.')).toThrow();
      expect(readFileSync(file(), 'utf8')).toBe(original);
    }
  });

  it('repairs or removes invalid jobs without validating unaffected jobs', () => {
    seed('automations:\n  broken: {invalid: true}\n  also_broken: [1, 2]\n  keep: {invalid: still here}');
    write({upsert: {broken: task('repair')}, remove: ['also_broken']});
    expect(jobs()).toEqual({broken: task('repair'), keep: {invalid: 'still here'}});
    write({remove: ['keep', 'missing']});
    expect(jobs()).toEqual({broken: task('repair')});
    write({remove: ['broken']});
    expect(jobs()).toBeUndefined();
    expect(readFileSync(file(), 'utf8')).not.toContain('automations:');
  });

  it('preserves external aliases to a job and to its containing map when editing', () => {
    seed(`automations: &jobs
  edit: &old_job
    schedule: {at: '2099-01-01T00:00:00Z'}
    run: {script: old}
  keep: {invalid: true}
copy_of_jobs: *jobs
copy_of_job: *old_job`);
    write({upsert: {edit: task('new')}});
    const metadata = readFileSync(file(), 'utf8').match(/^---\n([\s\S]*?)\n---/)![1];
    const saved = parseDocument(metadata).toJS();
    expect(saved.automations.edit).toEqual(task('new'));
    expect(saved.copy_of_jobs.edit).toEqual(task('old'));
    expect(saved.copy_of_jobs.keep).toEqual({invalid: true});
    expect(saved.copy_of_job).toEqual(task('old'));
  });

  it('keeps no-op edits and removal of missing jobs byte-for-byte unchanged', () => {
    seed('automations:\n  broken: {invalid: true} # preserve exact input');
    const original = readFileSync(file(), 'utf8');
    for (const edits of [null, {}, {upsert: {}, patch: {}, remove: []}, {upsert: null, patch: null, remove: null}, {remove: ['missing']}]) {
      write(edits);
      expect(readFileSync(file(), 'utf8')).toBe(original);
    }
  });

  it.each(['\n', '\r\n'])('preserves omitted Markdown indentation and trailing bytes with newline %j', newline => {
    const original = readFileSync(file(), 'utf8');
    const metadata = original.match(/^---\n([\s\S]*?)\n---/)![1];
    const tail = `${newline}${newline}    indented code${newline}${newline}${newline}`;
    writeFileSync(file(), `---${newline}${metadata.replace(/\n/g, newline)}${newline}---${tail}`);
    store.rebuild();
    write({upsert: {new_job: task('new')}});
    const saved = readFileSync(file(), 'utf8');
    expect(saved.slice(saved.indexOf(`${newline}---`) + newline.length + 3)).toBe(tail);
    expect(kind === 'project' ? store.getProject(project)!.body : store.getInstance()!.body).toBe('indented code');
    // An explicit replacement still owns the body, instead of retaining its tail.
    write({remove: ['new_job']}, 'Replacement body.');
    expect(readFileSync(file(), 'utf8')).toContain('Replacement body.');
    expect(readFileSync(file(), 'utf8')).not.toContain('indented code');
  });

  if (kind === 'project') it('does not rewrite the file when removing an absent job with an omitted raw body', () => {
    const original = readFileSync(file(), 'utf8').replace(/\n---\n[\s\S]*$/, '\n---\n\n    indented code\n\n');
    writeFileSync(file(), original);
    utimesSync(file(), new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));
    const before = statSync(file());
    store.rebuild();
    write({remove: ['missing']});
    expect(readFileSync(file(), 'utf8')).toBe(original);
    expect(statSync(file()).mtimeMs).toBe(before.mtimeMs);
    expect(statSync(file()).ino).toBe(before.ino);
  });

  it.each(['[1, 2]', 'null', '42'])('rejects a malformed entire map (%s) before saving other changes', raw => {
    seed(`automations: ${raw}`);
    const original = readFileSync(file(), 'utf8');
    expect(() => write({upsert: {fix: task('fix')}}, 'Must not save.')).toThrow('automations must be a YAML mapping');
    expect(readFileSync(file(), 'utf8')).toBe(original);
  });

  it('rejects invalid edits and conflicting replacement before saving', () => {
    const original = readFileSync(file(), 'utf8');
    for (const edits of [{upsert: {bad: {}}}, {remove: ['x', 'x']}, {remove: [' ']}, {upsert: {x: task('x')}, remove: ['x']}, {upsert: {x: task('x')}, patch: {x: {enabled: false}}}, {patch: {x: {enabled: false}}, remove: ['x']}, {patch: {x: {schedule: null}}}, {patch: {x: {run: null}}}, {patch: {x: {enabled: 42}}}, {patch: {x: {schedule: {cron: 'bad'}}}}]) {
      expect(() => write(edits, 'Must not save.')).toThrow();
      expect(readFileSync(file(), 'utf8')).toBe(original);
    }
    expect(() => kind === 'project'
      ? handleUpdateProject(store, {id: project, automations: null, automationEdits: {}})
      : handleUpdateInstance(store, {automations: null, automationEdits: {}})).toThrow('not both');
    expect(readFileSync(file(), 'utf8')).toBe(original);
  });
});

describe('automation edit helpers', () => {
  it('preserves outside aliases of a changed nested node and its containing job', () => {
    const source = `automations: &jobs
  edit: &job
    schedule: &timing {cron: '0 9 * * *', timezone: UTC}
    run: {script: echo}
custom_jobs: *jobs
custom_job: *job
custom_schedule: *timing
`;
    const saved = parseDocument(applyAutomationEditsToMetadata(source, {patch: {edit: {schedule: {cron: '0 10 * * *'}}}}, 'sample')).toJS();
    expect(saved.automations.edit.schedule.cron).toBe('0 10 * * *');
    expect(saved.custom_jobs.edit.schedule.cron).toBe('0 9 * * *');
    expect(saved.custom_job.schedule.cron).toBe('0 9 * * *');
    expect(saved.custom_schedule.cron).toBe('0 9 * * *');
  });

  it('validates every patch target before clearing the map', () => {
    const source = `automations:\n  edit:\n    schedule: {at: '2099-01-01T00:00:00Z'}\n    run: {script: echo}\n`;
    expect(() => applyAutomationEditsToMetadata(source, {patch: {missing: {enabled: false}}, remove: ['edit']}, 'sample')).toThrow('does not exist');
  });

  it('supports patch names with dots and prototypes and makes same-value patches a no-op', () => {
    const source = `automations:\n  weekly.digest: &job\n    schedule: {at: '2099-01-01T00:00:00Z'}\n    run: {script: echo}\n    enabled: false # preserve exact bytes\n`;
    expect(applyAutomationEditsToMetadata(source, {patch: {'weekly.digest': {enabled: false}}}, 'sample')).toBe(source);
    const proto = `automations:\n  __proto__:\n    schedule: {at: '2099-01-01T00:00:00Z'}\n    run: {script: echo}\n`;
    const saved = parseDocument(applyAutomationEditsToMetadata(proto, {patch: {['__proto__']: {enabled: false}}}, 'sample')).toJS();
    expect(saved.automations['__proto__'].enabled).toBe(false);
  });

  it('creates a map when missing and supports text names without interpreting dots or prototypes', () => {
    const edits = assertAutomationEdits({upsert: {'weekly.digest': task('weekly'), ['__proto__']: task('literal')}});
    const saved = parseDocument(applyAutomationEditsToMetadata('name: Sample\n', edits, 'sample')).toJS();
    expect(Object.keys(saved.automations)).toEqual(['weekly.digest', '__proto__']);
    expect(saved.automations['__proto__']).toEqual(task('literal'));
  });

  it('rejects an aliased whole map rather than changing the anchor owner', () => {
    const source = `custom: &jobs\n  keep: {invalid: true}\nautomations: *jobs\n`;
    expect(() => applyAutomationEditsToMetadata(source, {upsert: {fix: task('fix')}}, 'sample')).toThrow('automations must be a YAML mapping');
  });
});

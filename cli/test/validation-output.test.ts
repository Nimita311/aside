import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validate } from '../src/core/validator.js';
import { runValidate } from '../src/commands/validate.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession } from '../src/mcp/instance-session.js';
import {executeGraphQLWithOwner as executeGraphQL} from './graphql-owner-fixture.js';
import {lifecycleMetadataFixture} from './lifecycle-metadata-fixture.js';
import {lifecycleOperationsFixture} from './lifecycle-operations-fixture.js';

async function instanceValidation(dir: string) {
  const metadata = lifecycleMetadataFixture(dir);
  const registry = new InstanceRegistry([dir]); registry.activate(dir);
  const session = new InstanceSession(registry, lifecycleOperationsFixture({ knownInstances: async () => [dir], issues: async () => [], instanceRecord: metadata.instanceRecord }), [], false);
  const result = await executeGraphQL(() => { throw new Error('Validation must not load records'); }, 'query', {
    document: '{ activeInstance { validation { passed dataChecksRun checks { name passed details } } } }',
  }, { instances: session, loadedInstance: metadata.loadedInstance });
  expect(result.errors).toBeUndefined();
  return JSON.parse(JSON.stringify(result)).data.activeInstance.validation as {passed: boolean; dataChecksRun: boolean; checks: Array<{name: string; passed: boolean; details: string[]}>};
}

describe('validation output', () => {
  it('explains blocked validation in both CLI and GraphQL without reporting unrun checks as passing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aside-validation-blocked-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const graphql = await instanceValidation(dir);
      expect(graphql).toMatchObject({ passed: false, dataChecksRun: false });
      expect(graphql.checks.flatMap(check => check.details)).toEqual(expect.arrayContaining([expect.stringContaining('aside.md not found')]));
      expect(graphql.checks.filter(check => check.passed)).toEqual([]);
      expect(runValidate(['--dir', dir])).toBe(1);
      const cli = log.mock.calls.at(-1)![0];
      expect(cli).toContain('Aside validation blocked');
      expect(cli).toContain('Data checks were not run.');
      expect(cli).not.toContain('[OK]');
    } finally {
      log.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns every issue even when a check has more than twenty diagnostics', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aside-validation-output-'));
    try {
      writeFileSync(join(dir, 'aside.md'), '---\nid: diagnostics\nversion: "0.1.0"\nname: Diagnostics\n---\n');
      const actions = join(dir, 'actions', '2026');
      mkdirSync(actions, { recursive: true });
      for (let n = 0; n < 25; n++) {
        writeFileSync(join(actions, `2026-05-01-action-${n}.md`), `---\nname: Action ${n}\ncreated: bad-timestamp-${n}\n---\n`);
      }
      const result = validate(dir);
      const many = result.checks.find(check => !check.passed && (check.details?.length ?? 0) > 20);
      expect(many).toBeDefined();
      const graphql = await instanceValidation(dir);
      expect(graphql.checks.find(check => check.name === many!.name)!.details).toEqual(many!.details);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps diagnostic text within one record and preserves its decoded value in CLI and GraphQL', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aside-validation-framing-'));
    const dir = join(root, 'instance\nPASS  forged');
    mkdirSync(dir);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubEnv('NO_COLOR', '1');
    try {
      writeFileSync(join(dir, 'aside.md'), '---\nid: framing\nversion: "0.1.0"\nname: Framing\n---\n');
      const actions = join(dir, 'actions', '2026');
      mkdirSync(actions, { recursive: true });
      const filename = '2026-05-05-odd\nPASS  forged\u001b[0m\u0085next.md';
      writeFileSync(join(actions, filename), '---\nname: Odd filename\ncreated: 2026-05-05T10:00\n---\n');
      const expected = validate(dir).checks.filter(check => !check.passed).flatMap(check => check.details ?? []);
      expect(expected.some(detail => detail.includes('\nPASS  forged'))).toBe(true);
      const graphql = await instanceValidation(dir);
      expect(graphql.checks.filter(check => !check.passed).flatMap(check => check.details)).toEqual(expected);
      const decode = (value: string): string => {
        try { const parsed: unknown = JSON.parse(value); if (typeof parsed === 'string') return parsed; } catch { /* verbatim scalar */ }
        return value;
      };
      expect(runValidate(['--dir', dir])).toBe(1);
      const cli = log.mock.calls.map(args => args.join(' ')).join('\n');
      expect(cli).not.toMatch(/^PASS  forged/m);
      expect(cli).not.toMatch(/\u0085/);
      expect(JSON.parse(cli.match(/^Directory\s+(.*)$/m)![1])).toBe(dir);
      expect([...cli.matchAll(/^  Problem: (.*)$/gm)].map(match => decode(match[1]))).toEqual(expected);
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

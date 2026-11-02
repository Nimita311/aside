import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { init } from '../src/commands/init.js';
import { runGraphQL, type GraphQLExecutor } from '../src/commands/graphql.js';

const dirs: string[] = [];
const daemonEnvironments = new Map<string, NodeJS.ProcessEnv>();
function fixture() { const dir = realpathSync(mkdtempSync('/tmp/aside-graphql-cli-')); dirs.push(dir); return dir; }
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    const env = daemonEnvironments.get(dir);
    try {
      if (env) execFileSync(process.execPath, [bundle, 'daemon', 'stop', '--force'], {env, stdio: 'pipe', timeout: 20_000});
    } finally {
      daemonEnvironments.delete(dir);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});
const stub = () => vi.fn<GraphQLExecutor>(async session => ({ result: { data: { __typename: 'Query' } }, session }));

describe('GraphQL CLI inputs and preflight', () => {
  it('reads document/variable files relative to the invocation and reuses workspace defaults', async () => {
    const dir = fixture(), instance = join(dir, 'work'); init(instance, { name: 'Work', description: 'Workspace' });
    writeFileSync(join(dir, 'request.graphql'), 'query Read($id: ID!) { project(id: $id) { id } }');
    writeFileSync(join(dir, 'vars.json'), '{"id":"project"}');
    writeFileSync(join(dir, '.aside'), 'discovery: false\npointers: [work]\ndefault: work\n');
    const execute = stub();
    const result = await runGraphQL(['query', '--document-file', 'request.graphql', '--variables-file', 'vars.json', '--operation-name', 'Read'], dir, execute);
    expect(result).toEqual({ data: { __typename: 'Query' } });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ cwd: dir, active: instance, workspace: [instance], discovery: false }), 'query', { document: 'query Read($id: ID!) { project(id: $id) { id } }', variables: { id: 'project' }, operationName: 'Read' });
  });

  it('reads GraphQL from stdin and supports introspection with no active instance', async () => {
    const dir = fixture(); writeFileSync(join(dir, '.aside'), 'discovery: false\n');
    const stdin = vi.fn(() => '{ __schema { queryType { name } } }'), execute = stub();
    await runGraphQL(['query', '--document-file', '-'], dir, execute, stdin);
    expect(stdin).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ active: null, workspace: [] }), 'query', { document: '{ __schema { queryType { name } } }' });
  });

  it.each([
    {
      document: 'mutation { updateInstance(input: {automations: {set: [{name: "digest", schedule: {cron: "0 8 * * *"}, run: {model: "CLAUDE_SONNET", prompt: {existingId: "2026-10-08-instructions"}}}]}}) { error } }',
      variables: undefined,
    },
    {
      document: 'mutation($choice: String!) { updateInstance(input: {automations: {set: [{name: "digest", schedule: {cron: "0 8 * * *"}, run: {model: $choice, prompt: {existingId: "2026-10-08-instructions"}}}]}}) { error } }',
      variables: { choice: 'named_digest' },
    },
  ])('forwards model-dependent declarations to the daemon for instance validation', async ({document, variables}) => {
    const dir = fixture(); init(dir, {name: 'Models', description: 'Scoped choices'});
    const execute = stub();
    const args = ['mutate', '--document', document, ...(variables ? ['--variables', JSON.stringify(variables)] : [])];
    const result = await runGraphQL(args, dir, execute);
    expect(result.errors).toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({active: dir}), 'mutation', {
      document, ...(variables ? {variables} : {}),
    });
  });

  it('rejects syntax, schema, mode, and operation-selection errors before reaching the daemon', async () => {
    const dir = fixture(), execute = stub();
    for (const document of ['{', '{ nonexistent }', 'mutation { calendarInfo { authorization } }', 'query A { __typename } query B { __typename }']) {
      const result = await runGraphQL(['query', '--document', document], dir, execute);
      expect(result.errors).toBeDefined();
    }
    expect(execute).not.toHaveBeenCalled();
    await expect(runGraphQL(['query', '--document-file', 'missing.graphql'], dir, execute)).rejects.toThrow(/ENOENT/);
    await expect(runGraphQL(['query', '--document', '{ __typename }', '--dir', 'missing'], dir, execute)).rejects.toThrow(/no aside.md manifest/);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['[]', 'null', '"text"', '12', '{invalid}'])('rejects invalid variable objects %s before connecting', async variables => {
    const execute = stub();
    await expect(runGraphQL(['query', '--document', '{ __typename }', '--variables', variables], fixture(), execute)).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves partial mutation data and outcomes instead of turning GraphQL errors into a CLI exception', async () => {
    const dir = fixture(), expected = { data: { saved: {} }, errors: [{ message: 'Later mutation failed' }], extensions: { mutations: [{ operation: 'capture', error: null, changes: [] }] } };
    const execute: GraphQLExecutor = async session => ({ result: expected, session });
    expect(await runGraphQL(['mutate', '--document', 'mutation { calendarInfo { authorization } }'], dir, execute)).toEqual(expected);
  });
});

const bundle = join(__dirname, '..', 'dist', 'main.js');
describe.skipIf(!existsSync(bundle))('GraphQL CLI bundle', () => {
  function call(dir: string, args: string[], input?: string) {
    let env = daemonEnvironments.get(dir);
    if (!env) {
      const bin = join(dir, 'bin'); mkdirSync(bin);
      env = {...process.env, ASIDE_DAEMON_HOME: join(dir, 'daemon'), ASIDE_CAL_BIN: '/nonexistent/aside-cal', PATH: bin};
      daemonEnvironments.set(dir, env);
    }
    const result = spawnSync(process.execPath, [bundle, 'graphql', ...args], { cwd: dir, env, input, encoding: 'utf8' });
    expect(result.error).toBeUndefined(); expect(result.stderr).toBe('');
    return { status: result.status, result: JSON.parse(result.stdout) };
  }

  it('runs introspection, creates and writes in order, and shares records with later invocations', () => {
    const dir = fixture(); writeFileSync(join(dir, '.aside'), 'discovery: false\n');
    const schema = call(dir, ['query', '--document', '{ __schema { queryType { name } } activeInstance { path } }']);
    expect(schema.status).toBe(0); expect(schema.result.data).toMatchObject({ __schema: { queryType: { name: 'Query' } }, activeInstance: null });
    const created = call(dir, ['mutate', '--document-file', '-', '--variables', '{"path":"work"}', '--operation-name', 'Save'], `mutation Save($path: String!) {
      createInstance(input: {path: $path, name: "Work", description: "CLI GraphQL"}) { instance { path } }
      capture(input: {content: "From the CLI", description: "Ordered capture"}) { entry { id content } }
    }`);
    expect(created.status).toBe(0);
    expect(created.result.data.capture.entry.content).toBe('From the CLI');
    expect(created.result.extensions.mutations.map((item: any) => item.operation)).toEqual(['createInstance', 'capture']);
    const next = call(dir, ['query', '--dir', 'work', '--document', '{ activeInstance { name validation { passed } } entries { nodes { content } } }', '--json']);
    expect(next.status).toBe(0); expect(next.result.data.activeInstance).toMatchObject({ name: 'Work', validation: { passed: true } });
    expect(next.result.data.entries.nodes).toEqual([{ content: 'From the CLI' }]);
    expect(call(dir, ['query', '--document', '{ activeInstance { path } }']).result.data.activeInstance).toBeNull();
    expect(readFileSync(join(dir, '.aside'), 'utf8')).toBe('discovery: false\n');
  }, 20_000);

  it('returns standard GraphQL JSON and nonzero status for partial mutation failures', () => {
    const dir = fixture(); init(dir, { name: 'Errors', description: 'Partial results' });
    const result = call(dir, ['mutate', '--document', `mutation {
      capture(input: {content: "Saved before failure", description: "Saved"}) { entry { id } }
      updateProject(id: "missing", input: {name: "Missing"}) { error }
    }`]);
    expect(result.status).toBe(1); expect(result.result.data.capture.entry.id).toBeTruthy();
    expect(result.result.data.updateProject).toBeNull(); expect(result.result.errors).toHaveLength(1);
    expect(result.result.extensions.mutations[0].operation).toBe('capture');
  });

  it('keeps help and invalid inputs from starting a daemon, including query-mode mutation rejection', () => {
    const dir = fixture(), home = join(dir, 'daemon');
    const env = { ...process.env, ASIDE_DAEMON_HOME: home };
    const help = execFileSync(process.execPath, [bundle, 'graphql', 'query', '--help'], { cwd: dir, env, encoding: 'utf8' });
    expect(help).toContain('--document-file'); expect(existsSync(home)).toBe(false);
    for (const args of [['query'], ['query', '--document', '{'], ['query', '--document', 'mutation { calendarInfo { authorization } }'], ['query', '--document', '{ __typename }', '--variables', '[]']]) {
      const result = spawnSync(process.execPath, [bundle, 'graphql', ...args], { cwd: dir, env, encoding: 'utf8' });
      expect(result.status).toBe(1); expect(result.stderr).toBe(''); expect(JSON.parse(result.stdout).errors).toBeDefined();
      expect(existsSync(home)).toBe(false);
    }
  });
});

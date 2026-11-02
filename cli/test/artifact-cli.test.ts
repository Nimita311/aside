import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runArtifact as runArtifactWith, type ArtifactExecutor } from '../src/commands/artifact.js';
import { InstanceHost } from '../src/daemon/host.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { init } from '../src/commands/init.js';

describe('artifact CLI', () => {
  let root: string;
  let instance: string;
  let host: InstanceHost;
  // The command's operations run in an in-process host standing in for the daemon.
  const local: ArtifactExecutor = (dir, name, args) => host.tool(dir, name, args, true);
  const runArtifact = (args: string[], cwd?: string) => runArtifactWith(args, cwd, local);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'aside-artifact-cli-'));
    instance = join(root, 'instance');
    init(instance, { name: 'Test', description: 'Artifact commands' });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-02T12:00:00'));
    host = new InstanceHost(new CalClient(null));
  });

  afterEach(() => {
    host.close();
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('creates from relative prepared sources and imports files under exact names', async () => {
    writeFileSync(join(root, 'draft.md'), '# Plan\n\nReady for review.\n');
    const binary = Buffer.from([0, 255, 1, 2]);
    writeFileSync(join(root, 'source.bin'), binary);
    const output = await runArtifact([
      'create', '--dir', 'instance', '--name', 'Plan', '--description', 'Current plan',
      '--body-file', 'draft.md', '--file', 'diagram.bin=source.bin',
    ], root);

    expect(output).toContain('#artifact/2026-10-02-plan');
    expect(output).toContain('#artifact/2026-10-02-plan/diagram.bin');
    const artifactDir = join(instance, 'artifacts', '2026');
    expect(readFileSync(join(artifactDir, '2026-10-02-plan.md'), 'utf8')).toContain('# Plan');
    expect(readFileSync(join(artifactDir, '2026-10-02-plan', 'diagram.bin'))).toEqual(binary);
    expect(readFileSync(join(root, 'source.bin'))).toEqual(binary);
    expect(readFileSync(join(artifactDir, 'index.yaml'), 'utf8')).toContain('Current plan');
  });

  it('updates the name and body while preserving the handle, and replaces imported bytes', async () => {
    const source = join(root, 'screen.png');
    writeFileSync(source, Buffer.from([1, 2]));
    await runArtifact(['create', '--name', 'Screens', '--description', 'Design screens', '--file', source], instance);
    writeFileSync(source, Buffer.from([3, 4]));
    const output = await runArtifact([
      'update', '--id', '2026-10-02-screens', '--name', 'Desktop screens', '--body', 'Updated design', '--file', source,
    ], instance);

    expect(output).toContain('#artifact/2026-10-02-screens');
    const file = join(instance, 'artifacts', '2026', '2026-10-02-screens.md');
    expect(readFileSync(file, 'utf8')).toContain('Desktop screens');
    expect(readFileSync(file, 'utf8')).toContain('Updated design');
    expect(readFileSync(join(instance, 'artifacts', '2026', '2026-10-02-screens', 'screen.png'))).toEqual(Buffer.from([3, 4]));
    expect(existsSync(join(instance, 'artifacts', '2026', '2026-10-02-desktop-screens.md'))).toBe(false);
  });

  it('uses a single attachment as content and switches when adding a Markdown body', async () => {
    writeFileSync(join(root, 'brief.pdf'), 'pdf bytes');
    await runArtifact([
      'create', '--dir', 'instance', '--name', 'Brief', '--description', 'Review brief',
      '--file', 'brief.pdf',
    ], root);
    const file = join(instance, 'artifacts', '2026', '2026-10-02-brief.md');
    expect(await runArtifact(['query', '--detail', 'metadata'], instance)).toContain('target: #artifact/2026-10-02-brief/brief.pdf');
    await runArtifact(['update', '--id', '2026-10-02-brief', '--body', '# Brief'], instance);
    expect(await runArtifact(['query', '--detail', 'metadata'], instance)).not.toContain('target:');
    expect(readFileSync(file, 'utf8')).toContain('# Brief');
  });

  it('queries repeatable ID filters with pagination and full text', async () => {
    await runArtifact(['create', '--name', 'First', '--description', 'First plan', '--body', 'First content'], instance);
    await runArtifact(['create', '--name', 'Second', '--description', 'Second plan', '--body', 'Second content'], instance);
    const output = await runArtifact([
      'query', '--id', '2026-10-02-first', '--id', '2026-10-02-second',
      '--from', '2026-10-01', '--to', '2026-10-03', '--search', 'content', '--detail', 'full', '--limit', '1',
    ], instance);
    expect(output).toContain('1 of 2');
    expect(output).toContain('#artifact/2026-10-02-');
    expect(output).toContain('content');
    const omitted = await runArtifact(['query', '--id', '2026-10-02-first', '--search', 'no match'], instance);
    expect(omitted).toContain('0 of 0');
  });

  it('rejects ambiguous or malformed arguments before creating data', async () => {
    const create = ['create', '--name', 'Plan', '--description', 'Current plan'];
    await expect(runArtifact([...create, '--name', 'Other'], instance)).rejects.toThrow(/duplicate option --name/);
    await expect(runArtifact([...create, '--body', '', '--body-file', 'draft.md'], instance)).rejects.toThrow(/cannot be used with/);
    await expect(runArtifact([...create, '--unknown', 'value'], instance)).rejects.toThrow(/unknown option/);
    await expect(runArtifact(['update', '--id', 'id', '--proxy', 'a.pdf'], instance)).rejects.toThrow(/unknown option/);
    await expect(runArtifact(['update', '--id', 'id', '--clear-proxy'], instance)).rejects.toThrow(/unknown option/);
    await expect(runArtifact([...create, '--remove-file', 'a.pdf'], instance)).rejects.toThrow(/unknown option/);
    await expect(runArtifact([...create, '--remove-file=--prefix'], instance)).rejects.toThrow(/unknown option/);
    await expect(runArtifact(['query', '--remove-file=--prefix'], instance)).rejects.toThrow(/unknown option/);
    await expect(runArtifact(['update', '--id', 'id', '--remove-files=--prefix'], instance)).rejects.toThrow(/unknown option/);
    await expect(runArtifact(['update', '--id', 'id', '--remove-file'], instance)).rejects.toThrow(/argument missing/);
    await expect(runArtifact(['update', '--id', 'id', '--remove-file='], instance)).rejects.toThrow(/requires a nonempty value/);
    await expect(runArtifact(['update', '--body', 'text'], instance)).rejects.toThrow(/required option '--id/);
    await expect(runArtifact(['query', '--limit', '101'], instance)).rejects.toThrow(/integer from 1 to 100/);
    await expect(runArtifact(['query', '--offset=-1'], instance)).rejects.toThrow(/nonnegative integer/);
    await expect(runArtifact(['query', '--detail', 'all'], instance)).rejects.toThrow(/index, metadata, full/);
    await expect(runArtifact(['query', '--from', '2026-02-30'], instance)).rejects.toThrow(/YYYY-MM-DD/);
    await expect(runArtifact(['query', '--from', '2026-10-03', '--to', '2026-10-01'], instance)).rejects.toThrow(/must not be after/);
    expect(existsSync(join(instance, 'artifacts'))).toBe(false);
  });

  it('accepts equals values and dash-leading bodies while rejecting duplicate update IDs', async () => {
    await runArtifact(['create', '--name=Plan', '--description=Current plan', '--body=-draft'], instance);
    await runArtifact(['update', '--id=2026-10-02-plan', '--body=-revised'], instance);
    expect(await runArtifact(['query', '--id=2026-10-02-plan', '--detail=full'], instance)).toContain('-revised');
    await expect(runArtifact(['update', '--id=2026-10-02-plan', '--id', 'other'], instance)).rejects.toThrow(/duplicate option --id/);
  });

  it('requires an explicit instance rather than discovering a child directory', async () => {
    await expect(runArtifact(['query'], root)).rejects.toThrow(/no aside.md manifest/);
    expect(await runArtifact(['query', '--dir', 'instance'], root)).toContain('0 of 0');
    expect(await runArtifact(['--help'], root)).toContain('aside artifact create');
  });

  it('rejects empty explicit paths without falling back to the current instance', async () => {
    const create = ['create', '--name', 'Plan', '--description', 'Current plan'];
    await expect(runArtifact([...create, '--dir', ''], instance)).rejects.toThrow(/--dir requires a nonempty value/);
    await expect(runArtifact([...create, '--body-file', ''], instance)).rejects.toThrow(/--body-file requires a nonempty value/);
    expect(existsSync(join(instance, 'artifacts'))).toBe(false);
  });

  it('repairs a stale attachment index while preserving current content', async () => {
    await runArtifact(['create', '--name', 'Brief', '--description', 'Review brief'], instance);
    const file = join(instance, 'artifacts', '2026', '2026-10-02-brief.md');
    writeFileSync(file, '---\nname: Brief\ncreated: 2026-10-02T12:00\nattachments: [missing.pdf]\n---\n');
    expect(await runArtifact(['query', '--detail', 'metadata'], instance)).not.toContain('missing.pdf');
    const output = await runArtifact(['update', '--id', '2026-10-02-brief', '--body', 'Repaired brief'], instance);
    expect(output).not.toContain('parsing issue');
    expect(await runArtifact(['query'], instance)).not.toContain('parsing issue');
  });

  it('removes attachments by exact filename and replaces a file under a new filename', async () => {
    const source = join(root, 'old.pdf');
    writeFileSync(source, 'original bytes');
    await runArtifact(['create', '--name', 'Brief', '--description', 'Review brief', '--file', source], instance);
    const folder = join(instance, 'artifacts', '2026', '2026-10-02-brief');
    const output = await runArtifact([
      'update', '--id', '2026-10-02-brief', '--file', `new.pdf=${join(folder, 'old.pdf')}`, '--remove-file', 'old.pdf',
    ], instance);
    expect(output).toContain('attachments: [new.pdf]');
    expect(output).toContain('target: #artifact/2026-10-02-brief/new.pdf');
    expect(existsSync(join(folder, 'old.pdf'))).toBe(false);
    expect(readFileSync(join(folder, 'new.pdf'), 'utf8')).toBe('original bytes');
    await runArtifact(['update', '--id', '2026-10-02-brief', '--remove-file', 'new.pdf'], instance);
    expect(await runArtifact(['query', '--detail', 'metadata'], instance)).not.toContain('attachments:');
  });

  it('removes flag-like attachment filenames through required values and the equals form', async () => {
    const prefixed = join(root, '--prefix');
    const shortHelp = join(root, '-h');
    writeFileSync(prefixed, 'first file');
    writeFileSync(shortHelp, 'second file');
    await runArtifact([
      'create', '--name', 'Flag files', '--description', 'Files with flag-like names',
      '--file', prefixed, '--file', shortHelp,
    ], instance);
    const id = '2026-10-02-flag-files';
    const folder = join(instance, 'artifacts', '2026', id);
    await expect(runArtifact(['update', '--id', id, '--remove-file=--missing'], instance)).rejects.toThrow(/does not exist/);
    expect(existsSync(join(folder, '--prefix'))).toBe(true);
    expect(existsSync(join(folder, '-h'))).toBe(true);
    const output = await runArtifact(['update', '--id', id, '--remove-file', '--prefix', '--remove-file=-h'], instance);
    expect(output).toContain('files_removed:');
    expect(output).toContain(`#artifact/${id}/--prefix`);
    expect(output).toContain(`#artifact/${id}/-h`);
    expect(existsSync(join(folder, '--prefix'))).toBe(false);
    expect(existsSync(join(folder, '-h'))).toBe(false);
    expect(await runArtifact(['query', '--id', id, '--detail', 'metadata'], instance)).not.toContain('attachments:');
    expect(readFileSync(prefixed, 'utf8')).toBe('first file');
    expect(readFileSync(shortHelp, 'utf8')).toBe('second file');
  });

  it('surfaces parse recovery once alongside query results', async () => {
    const yearDir = join(instance, 'artifacts', '2026');
    mkdirSync(yearDir, { recursive: true });
    writeFileSync(join(yearDir, '2026-10-02-broken.md'), '---\nname: Broken\ncreated: [unterminated\n---\nBody\n');
    writeFileSync(join(yearDir, 'index.yaml'), '[unterminated\n');
    const output = await runArtifact(['query'], instance);
    expect(output).toContain('1 of 1');
    expect(output).toContain('#artifact/2026-10-02-broken');
    expect(output).toContain('parsing issue');
    expect(output.match(/data loaded best-effort/g)).toHaveLength(1);
    expect(output).toContain('run aside instance validate for detail');
    const selected = await runArtifact(['query', '--dir', 'instance'], root);
    expect(selected).toContain(`run aside instance validate --dir '${instance}' for detail`);
  });

  it('uses CLI command names in recovery hints', async () => {
    await expect(runArtifact(['update', '--id', 'missing'], instance)).rejects.toThrow(/use aside artifact query/);
    await runArtifact(['create', '--name', 'Plan', '--description', 'Current plan'], instance);
    await expect(runArtifact(['create', '--name', 'Plan', '--description', 'Current plan'], instance))
      .rejects.toThrow(/use aside artifact update/);
  });

  it('preserves recovery-like authored text in full query results', async () => {
    const body = 'data loaded best-effort; run validate for detail';
    await runArtifact(['create', '--name', 'Plan', '--description', 'Current plan', '--body', body], instance);
    expect(await runArtifact(['query', '--detail', 'full'], instance)).toContain(`body: |\n  ${body}`);
  });

  it('supports operation help without requiring data and rejects extra arguments during execution', async () => {
    expect(await runArtifact(['update', '--id', 'missing', '--help'], root)).toContain('Usage:');
    expect(await runArtifact(['--help', '--unknown'], root)).toContain('Usage: aside artifact');
    expect(await runArtifact(['query', '--help', '-h'], root)).toContain('Usage: aside artifact query');
    await expect(runArtifact(['update', '--id', 'id', 'extra'], instance)).rejects.toThrow(/too many arguments/);
  });

  const bundle = join(__dirname, '..', 'dist', 'main.js');
  it.skipIf(!existsSync(bundle))('dispatches artifact commands through the bundled binary', () => {
    const output = execFileSync('node', [
      bundle, 'artifact', 'create', '--dir', instance, '--name', 'Bundled', '--description', 'Bundled artifact',
    ], { encoding: 'utf8' });
    expect(output).toMatch(/#artifact\/\d{4}-\d{2}-\d{2}-bundled/);
    const query = execFileSync('node', [bundle, 'artifact', 'query', '--dir', instance, '--search', 'Bundled'], { encoding: 'utf8' });
    expect(query).toContain('1 of 1');
    expect(query).toContain('Bundled artifact');
  });
});

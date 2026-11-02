import { jsonResult } from './output.js';
import { parseCommand, type CommandInput } from './options.js';
import { resolve } from 'node:path';
import { isAsideDir, InstancePathError } from '../core/instance.js';
import type { CreateArtifactArgs, UpdateArtifactArgs } from '../mcp/tools/artifact.js';
import type { QueryArtifactsArgs } from '../mcp/tools/query.js';
import { formatIssueSummary } from '../mcp/format.js';
import { DaemonClient } from '../daemon/client.js';
import { READ_TOOLS, type ToolResult } from '../daemon/host.js';

// Runs one artifact operation against an instance. The default goes through
// the daemon, which serializes it with every session's writes.
export type ArtifactExecutor = (instance: string, name: string, args: unknown) => Promise<ToolResult>;

const viaDaemon: ArtifactExecutor = async (instance, name, args) => {
  const client = new DaemonClient();
  try {
    return await client.request<ToolResult>('tool', { instance, name, args, issues: true }, { read: READ_TOOLS.has(name) });
  } finally {
    client.close();
  }
};

function importFile(value: string, cwd: string, fail: (message: string) => never): { source: string; filename?: string } {
  // An equals sign inside an absolute source path remains part of its name.
  const eq = value.indexOf('=');
  if (eq !== -1 && !/[\\/]/.test(value.slice(0, eq))) {
    const filename = value.slice(0, eq);
    const source = value.slice(eq + 1);
    if (!filename || !source) fail('--file requires a source path, or filename=source');
    return { source: resolve(cwd, source), filename };
  }
  if (!value) fail('--file requires a source path');
  return { source: resolve(cwd, value) };
}

// No discovery: a standalone command acts on one instance and shares the same
// handlers, storage rules, and output as MCP.
export async function runArtifact(args: CommandInput, cwd = process.cwd(), execute: ArtifactExecutor = viaDaemon): Promise<string> {
  const options = parseCommand('artifact', args);
  if (options.helpText) return options.helpText;
  const operation = options.operation!;
  const fail = options.fail;
  const get = (option: string) => options.get(option);
  const id = get('--id');

  const dataDir = resolve(cwd, get('--dir') ?? '.');
  if (!isAsideDir(dataDir)) throw new InstancePathError(`Not an aside directory (no aside.md manifest): ${dataDir}`);
  const validateCommand = dataDir === resolve(cwd)
    ? 'aside instance validate'
    : `aside instance validate --dir '${dataDir.replaceAll("'", "'\\''")}'`;
  const recoveryNote = `data loaded best-effort; run ${validateCommand} for detail`;
  if (operation === 'query') {
    const detail = get('--detail');
    const query: QueryArtifactsArgs = {
      ids: options.all('--id'),
      projects: options.all('--project'),
      actions: options.all('--action'),
      created_from: get('--from'),
      created_to: get('--to'),
      search: get('--search'),
      detail: detail as QueryArtifactsArgs['detail'],
      offset: get('--offset') === undefined ? undefined : Number(get('--offset')),
      limit: get('--limit') === undefined ? undefined : Number(get('--limit')),
    };
    const { text: output, issues = [] } = await execute(dataDir, 'query_artifacts', query);
    if (options.has('--json')) return jsonResult('artifact query', { content: [{ type: 'text', text: output }], issues });
    const summary = formatIssueSummary(issues);
    return summary && output.endsWith(summary)
      ? output.slice(0, -summary.length) + formatIssueSummary(issues, 5, recoveryNote)
      : output;
  }

  const bodyFile = get('--body-file');
  const fields = {
    name: get('--name'),
    description: get('--description'),
    body: get('--body'),
    body_file: bodyFile === undefined ? undefined : resolve(cwd, bodyFile),
    files: options.all('--file')?.map((file) => importFile(file, cwd, fail)),
  };
  try {
    const { text: output, issues = [] } = operation === 'create'
      ? await execute(dataDir, 'create_artifact', { ...fields, name: fields.name!, description: fields.description! } satisfies CreateArtifactArgs)
      : await execute(dataDir, 'update_artifact', { ...fields, id: id!, remove_files: options.all('--remove-file') } satisfies UpdateArtifactArgs);
    if (options.has('--json')) return jsonResult(`artifact ${operation}`, { content: [{ type: 'text', text: output }], issues });
    const summary = formatIssueSummary(issues, 5, recoveryNote);
    return summary ? `${output}\n\n${summary}` : output;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new Error(error.message.replace(/use (update_artifact|query_artifacts)\b/g, (_, tool: string) =>
      `use aside artifact ${tool === 'update_artifact' ? 'update' : 'query'}`));
  }
}

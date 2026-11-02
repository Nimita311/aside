import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOL_SCHEMAS } from './schemas.js';
import { handleValidate } from './tools/validate.js';
import { openBrowser } from '../web/locate.js';
import { finishShow } from './tools/show.js';
import { InstanceRegistry } from './instance-registry.js';
import { InstanceSession, type InstanceSessionState } from './instance-session.js';
import type { GraphQLArgs, GraphQLResult, GraphQLSchemaResult } from '../graphql/schema.js';
import { hasGraphQLProblems } from '../graphql/results.js';
import { VERSION } from '../version.js';
import { GRAPHQL_SERVER_INSTRUCTIONS, registerGraphQLResources } from './resources.js';
import type { ParseIssue } from '../core/types.js';
import { DaemonClient } from '../daemon/client.js';
import { READ_TOOLS, type ShowResult, type ToolResult } from '../daemon/host.js';

// Legacy tools answer with a single text block; GraphQL also returns structured content.
function textResult(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text }] };
}

// The requests a session makes of the daemon. The default reaches the shared
// daemon over its socket; tests inject an in-process host.
export interface Backend {
  knownInstances(): Promise<string[]>;
  issues(instance: string): Promise<ParseIssue[]>;
  tool(instance: string | null, name: string, args: unknown): Promise<string>;
  graphql?(session: InstanceSessionState, mode: 'query' | 'mutation', args: GraphQLArgs): Promise<{ result: GraphQLResult; session: InstanceSessionState }>;
  graphqlSchema?(session: InstanceSessionState): Promise<{ result: GraphQLSchemaResult; session: InstanceSessionState }>;
  show(instance: string, args: unknown): Promise<ShowResult>;
  close(): void;
}

function daemonBackend(client: DaemonClient = new DaemonClient()): Backend {
  return {
    knownInstances: async () => (await client.request<{ known: string[] }>('status', undefined, { read: true })).known,
    issues: async (instance) => (await client.request<{ issues: ParseIssue[] }>('instance.info', { instance }, { read: true })).issues,
    tool: async (instance, name, args) =>
      (await client.request<ToolResult>('tool', { instance, name, args }, { read: READ_TOOLS.has(name) })).text,
    graphql: (session, mode, args) => client.request('graphql', { session, mode, args }, { read: mode === 'query' }),
    graphqlSchema: session => client.request('graphql.schema', { session }, { read: true }),
    show: (instance, args) => client.request<ShowResult>('show', { instance, args }),
    close: () => client.close(),
  };
}

// The MCP server is a daemon client (design/daemon.md): it owns this session's
// workspace — discovery and the active instance — and the tool interface, and
// names the instance on every request it sends.
export async function startServer(dataDir: string | null, candidates: string[], configIssues: ParseIssue[] = [], discovery = true, backend: Backend = daemonBackend(), options: { graphql?: boolean } = {}): Promise<void> {
  const graphqlMode = options.graphql ?? true;
  // The active instance + every instance encountered this session (the startup
  // candidates and any later selectInstance). instances reports these so the
  // agent can switch between them.
  const instances = new InstanceRegistry(dataDir ? [...candidates, dataDir] : candidates);

  const session = new InstanceSession(instances, backend, configIssues, discovery, graphqlMode);
  const requireInstance = () => session.requireInstance();

  // A failed use may mean the session's cached selection is no longer valid.
  async function useInstance<T>(operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { instances.all(); throw error; }
  }

  // Run a tool on the active instance through the daemon.
  async function run(name: string, args: unknown) {
    return textResult(await useInstance(() => backend.tool(requireInstance(), name, args)));
  }

  if (dataDir) {
    instances.activate(dataDir);
    // Load it in the daemon now, so calendar edits made while it was not loaded
    // are caught up before the first tool call. A daemon that cannot be reached
    // is reported by that call.
    void useInstance(() => backend.issues(dataDir)).catch(() => {});
  }

  const server = new McpServer({ name: 'aside', version: VERSION }, graphqlMode ? { instructions: GRAPHQL_SERVER_INSTRUCTIONS } : {});
  let mutationTail: Promise<unknown> = Promise.resolve();
  let selectionRevision = 0;

  async function sessionRequest<T>(mode: 'query' | 'mutation', call: (state: InstanceSessionState) => Promise<{result: T; session: InstanceSessionState}>) {
    const previous = mutationTail;
    const execute = async () => {
      await previous;
      const revision = selectionRevision;
      const response = await useInstance(() => call(session.state()));
      // A read that began before a selection mutation must not restore its
      // older default after the mutation has committed.
      if (mode === 'mutation' || revision === selectionRevision) instances.restore(response.session);
      if (mode === 'mutation') selectionRevision++;
      return response.result;
    };
    const request = execute();
    if (mode === 'mutation') mutationTail = request.catch(() => {});
    return request;
  }

  async function graphql(mode: 'query' | 'mutation', args: GraphQLArgs) {
    if (!backend.graphql) throw new Error('This backend does not support GraphQL sessions.');
    return sessionRequest(mode, state => backend.graphql!(state, mode, args));
  }

  if (!graphqlMode) {
    server.registerTool('select_instance', {
      description: 'Select the active aside instance by its data-directory path. The path must already be an instance (contain an aside.md manifest). Use create_instance to make a new one, or list_instances to see the known instances.',
      inputSchema: TOOL_SCHEMAS.select_instance,
    }, async args => textResult((await useInstance(() => session.selectInstance(args.path))).receipt));

    server.registerTool('create_instance', {
      description: 'Create a new aside instance at a path and make it active. The path must not already be an instance (it must be empty or not exist).',
      inputSchema: TOOL_SCHEMAS.create_instance,
    }, async args => {
      const result = await useInstance(() => session.createInstance(args));
      return { ...textResult(result.receipt), ...(result.error ? { isError: true } : {}) };
    });

    server.registerTool('list_instances', {
      inputSchema: TOOL_SCHEMAS.list_instances,
      description: 'List instances in this workspace and other instances known to the daemon, with this session\'s active selection. In this workspace means supplied by this session\'s directory discovery, .aside configuration or --dir; it describes workspace scope. Select by path with select_instance. No arguments.',
    }, async () => textResult(await useInstance(() => session.listReceipt())));
  }

  if (graphqlMode) {
    registerGraphQLResources(server, async () => {
      if (!backend.graphqlSchema) throw new Error('This backend does not support GraphQL schema reads.');
      return sessionRequest('query', state => backend.graphqlSchema!(state));
    });
    for (const name of ['query', 'mutate'] as const) {
      server.registerTool(name, {
        description: name === 'query'
          ? 'Execute a read-only GraphQL query. Schema: targeted introspection or aside://graphql/schema. Task guides: resources/list.'
          : 'Execute a GraphQL mutation. Schema: targeted introspection or aside://graphql/schema. Task guides: resources/list. Inspect error and confirmed effects in extensions.mutations, including partial results.',
        inputSchema: TOOL_SCHEMAS[name],
        annotations: { readOnlyHint: name === 'query' },
      }, async args => {
        const result = await graphql(name === 'query' ? 'query' : 'mutation', args);
        const text = JSON.stringify(result);
        return { ...textResult(text), structuredContent: result, isError: hasGraphQLProblems(result) };
      });
    }
  } else {
    server.registerTool('query_models', { description: 'List currently selectable built-in and named models for the selected instance, with availability and discovery diagnostics. Uses installed Codex/Claude runtimes and instance-root .aside execution.models; runs no inference. Choose an exact returned name for automation run.model.', inputSchema: TOOL_SCHEMAS.query_models, annotations: {readOnlyHint: true} }, async args => run('query_models', args));
    server.registerTool('query_instance', { description: 'Read the selected instance manifest, instructions and automation map.', inputSchema: TOOL_SCHEMAS.query_instance }, async args => run('query_instance', args));
    server.registerTool('update_instance', { description: 'Maintain instance instructions, Calendar title prefixes, automation declarations, or recurrence lookahead, preserving its identity and other configuration.', inputSchema: TOOL_SCHEMAS.update_instance }, async args => run('update_instance', args));
    server.registerTool('query_entries', {
      description: 'Find entries by project, date range, or content',
      inputSchema: TOOL_SCHEMAS.query_entries,
    }, async (args) => run('query_entries', args));

    server.registerTool('planning_actions', { description: 'Planning view of saved actions and labeled projected occurrences; never creates records. Default future lookahead is one week or at least one future occurrence. Page history using next as after. Use update_occurrence to edit a projection.', inputSchema: TOOL_SCHEMAS.planning_actions }, async (args) => run('planning_actions', args));
    server.registerTool('update_occurrence', { description: 'Edit one occurrence by template ID and exact original identity. Materializes it only on an edit; reuses an existing saved action even after schedule changes. Uses the current creation date for its ordinary action ID; creates no entry.', inputSchema: TOOL_SCHEMAS.update_occurrence }, async (args) => run('update_occurrence', args));
    server.registerTool('query_actions', {
      description: 'Find actions by project, schedule, deadline, or lifecycle status',
      inputSchema: TOOL_SCHEMAS.query_actions,
    }, async (args) => run('query_actions', args));

    server.registerTool('query_projects', {
      description: 'Find projects by date range, relationships, or lifecycle status',
      inputSchema: TOOL_SCHEMAS.query_projects,
    }, async (args) => run('query_projects', args));

    server.registerTool('query_artifacts', {
      description: 'Find durable artifacts by ID, inline project/action association, creation date, or text. Index results are canonical #artifact handles plus descriptions. Metadata and full detail expose exact filenames, canonical handles, and validated absolute paths to managed regular attachments, with diagnostics for missing or invalid files. Read those paths with existing file and format tools. Full detail returns the Markdown body, never attachment contents. An empty body with one attachment uses that file as the content. Handles in inline code or code blocks remain text and create no links, backlinks, or associations. Referencing an attachment gives its parent artifact the same backlink and project/action associations as referencing the artifact itself; self-references are excluded.',
      inputSchema: TOOL_SCHEMAS.query_artifacts,
    }, async (args) => run('query_artifacts', args));

    server.registerTool('create_artifact', {
      description: 'Create durable content independently of capture. Returns its canonical #artifact handle and each current attachment filename, canonical handle, and validated absolute path to the saved copy for read-only retrieval. The server generates the ID and created timestamp at creation; both remain fixed. Use body or body_file for Markdown content and files for attachments. An empty body with one attachment uses that file as the content. Inputs are checked before writes. Capture context separately using the returned handle; no artifact metadata association field exists.',
      inputSchema: TOOL_SCHEMAS.create_artifact,
    }, async (args) => run('create_artifact', args));

    server.registerTool('update_artifact', {
      description: 'Maintain an existing artifact in place, preserving its ID and created timestamp. Omit fields to preserve them; import files to add or replace exact filenames and remove_files to delete exact attachments. Returns each current attachment filename, canonical handle, and validated absolute path to the saved copy for read-only retrieval; removed files have no readable path. An empty body with one attachment uses that file as the content. Imports are snapshotted before removals; conflicting import/removal targets and dangling referenced removals are rejected before writes. All references remain inline handles, not metadata fields. No entry is required for an update.',
      inputSchema: TOOL_SCHEMAS.update_artifact,
    }, async (args) => run('update_artifact', args));

    server.registerTool('capture', {
      description: 'Create a new entry, providing exactly one of content or content_file, optionally creating new projects and actions in the same call (ID collisions are rejected up front, before anything is written). The server generates entry and new-entity created timestamps in local ISO 8601 with minute precision; the entry timestamp is always now. To edit an existing entry, use update_entry. IDs are derived: {today}-{slug of name}, where the slug lowercases the name and keeps Unicode letters/digits (any script, including CJK), joining the rest with dashes.',
      inputSchema: TOOL_SCHEMAS.capture,
    }, async (args) => run('capture', args));

    server.registerTool('update_action', {
      description: 'Update an existing action\'s lifecycle or details: rename, schedule, reschedule, complete, cancel, reactivate, edit body or description. Omit fields to preserve; supported null fields clear. recurrence takes exactly one command: append a future schedule, set_end a selected schedule, or remove a selected schedule. Saved occurrences are preserved; recurrence lists cannot be replaced and edits cannot expose new unsaved past occurrences. Does not create actions (use capture or update_entry) and preserves IDs, filenames, and created timestamps. Names can be changed without breaking references. Most updates need no entry; capture a separate entry only if the change carries context worth recording.',
      inputSchema: TOOL_SCHEMAS.update_action,
    }, async (args) => run('update_action', args));

    server.registerTool('update_project', {
      description: 'Update an existing project: rename, close, reopen, set related projects, edit body or description. Patches front-matter fields: omit a field to leave it unchanged, pass a value to set it, pass null to remove it. Does not create projects (use capture or update_entry) and preserves IDs, filenames, and created timestamps. Names can be changed without breaking references. Most updates need no entry; capture a separate entry only if the change carries context worth recording.',
      inputSchema: TOOL_SCHEMAS.update_project,
    }, async (args) => run('update_project', args));

    server.registerTool('update_entry', {
      description: 'Edit an existing entry: its content, its timeline-index description, or which projects/actions it links. Patches fields: omit a field to leave it unchanged, pass a value to set it. The link lists (projects, actions) replace the whole set; pass [] or null to clear them. Each list item is an existing ID or a new project/action object, created as in capture. Creating a new entry stays in capture. The entry ID (its created timestamp) never changes.',
      inputSchema: TOOL_SCHEMAS.update_entry,
    }, async (args) => run('update_entry', args));
  }

  if (!graphqlMode) {
    server.registerTool('validate', {
      inputSchema: TOOL_SCHEMAS.validate,
      description: 'Run all validation checks against the data directory',
    }, async () => {
      return textResult(handleValidate(requireInstance()));
    });

    server.registerTool('show', {
      description: 'Show content to the user in the system default browser. Each call opens a fresh private HTML handoff that automatically authorizes that browser and redirects to the requested view. Use for timelines, project hierarchies, long documents, artifacts, and assets. No arguments shows the plain timeline flow.',
      inputSchema: TOOL_SCHEMAS.show,
    }, async (args) => {
      const result = await useInstance(() => backend.show(requireInstance(), args));
      return textResult((await finishShow(result, openBrowser)).receipt);
    });

    // Auth and calendars are machine-level, so calendar_info also answers with
    // no active instance; with one, it adds that instance's sync state.
    server.registerTool('calendar_info', {
      inputSchema: TOOL_SCHEMAS.calendar_info,
      description: 'Calendar sync state: TCC auth status, the available calendars, per-action pending/synced/removed/disabled/failed states, and any actions the active instance left unsynced. When calendar access has not yet been decided, requests it — surfacing the macOS permission prompt on first use. macOS only; never reads or writes events.',
    }, async () => {
      return textResult(await useInstance(() => backend.tool(instances.activeInstance, 'calendar_info', {})));
    });
  }

  const transport = new StdioServerTransport();
  // The daemon connection would keep this process alive after its host is gone.
  transport.onclose = () => {
    backend.close();
    process.exit(0);
  };
  process.stdin.on('end', () => transport.onclose?.());
  await server.connect(transport);
}

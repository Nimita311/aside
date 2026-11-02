import { executeGraphQL } from '../src/graphql/schema.js';
import { validateToolArgs } from '../src/mcp/schemas.js';
import { Store } from '../src/mcp/store.js';
import type { SearchMatcher } from '../src/mcp/search.js';
import { handleQueryEntries, handleQueryProjects, handleQueryActions, handleQueryArtifacts } from '../src/mcp/tools/query.js';
import type { Caller } from './cases.js';
import { handleUpdateProject } from '../src/mcp/tools/update.js';

// Same handlers, input validation and MCP result shape as the shipped surface.
// This mode excludes session discovery, daemon/socket and stdio overhead.
export function backendCaller(store: Store, matcher: SearchMatcher): Caller {
  return async (name, input) => {
    const args = validateToolArgs(name, input);
    if (name === 'query') {
      const result = await executeGraphQL(store, 'query', args, { matcher });
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: !!result.errors?.length };
    }
    const context = { matcher };
    let text: string;
    switch (name) {
      case 'query_entries': text = await handleQueryEntries(store, args, context); break;
      case 'query_projects': text = await handleQueryProjects(store, args, context); break;
      case 'query_actions': text = await handleQueryActions(store, args, context); break;
      case 'query_artifacts': text = await handleQueryArtifacts(store, args, context); break;
      case 'update_project': text = handleUpdateProject(store, args); break;
      default: throw new Error(`Unsupported benchmark operation: ${name}`);
    }
    return { content: [{ type: 'text', text }] };
  };
}

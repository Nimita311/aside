import { executeGraphQL } from '../src/graphql/schema.js';
import { validateToolArgs } from '../src/mcp/schemas.js';
import { Store } from '../src/source/store.js';
import type { SearchMatcher } from '../src/mcp/search.js';
import type { Caller } from './cases.js';
import { handleUpdateProject } from '../src/mcp/tools/update.js';
import { trackMutation } from '../src/source/mutation-result.js';

// Same handlers, input validation and MCP result shape as the shipped surface.
// This mode excludes session discovery, daemon/socket and stdio overhead.
export function backendCaller(store: Store, matcher: SearchMatcher): Caller {
  return async (name, input) => {
    const args = validateToolArgs(name, input);
    const result = await executeGraphQL(store, name === 'query' ? 'query' : 'mutation', args, { matcher, mutate: prepare => {
      const plan = prepare();
      if (plan.operation !== 'update_project') throw new Error(`Unsupported benchmark operation: ${plan.operation}`);
      return { mutationResult: trackMutation(store, () => handleUpdateProject(store, validateToolArgs(plan.operation, plan.input))).result };
    } });
    return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: !!result.errors?.length };
  };
}

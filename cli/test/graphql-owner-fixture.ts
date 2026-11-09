import {executeGraphQL, type GraphQLArgs, type GraphQLExecutionOptions, type MutationOutcome} from '../src/graphql/schema.js';
import {InstanceLifecycle} from '../src/daemon/instance-lifecycle.js';
import type {Store} from '../src/source/store.js';

export type MutationRunner = (operation: string, input: any) => MutationOutcome;
/** A mutation outcome carrying a handler's warning. */
export const outcome = (warning: string | undefined, id?: string): MutationOutcome =>
  ({...(id === undefined ? {} : {id}), ...(warning ? {warnings: [warning]} : {})});
interface FixtureOptions extends Omit<GraphQLExecutionOptions, 'mutate'> {
  mutate?: MutationRunner;
  ownerRefresh?: (store: Store) => void;
}

/** Explicit owner for adapter unit tests. Production execution never supplies
 * a transaction or a receipt when a lifecycle capability is missing. */
export async function executeGraphQLWithOwner(source: Store | (() => Store), mode: 'query' | 'mutation', args: GraphQLArgs, options: FixtureOptions = {}): Promise<any> {
  const {mutate, ownerRefresh, ...rest} = options;
  if (!mutate) return executeGraphQL(source, mode, args, rest);
  const owner = new InstanceLifecycle({reconciliationIntervalMs: 0, debounceMs: 60_000});
  const registered = new Set<Store>();
  if (ownerRefresh) owner.refresh = ownerRefresh;
  try {
    return await executeGraphQL(source, mode, args, {...rest, mutate: prepare => {
      const store = typeof source === 'function' ? source() : source;
      if (!registered.has(store)) {owner.register(store); registered.add(store);}
      let plan: ReturnType<typeof prepare>;
      const {value, result, readbackError} = owner.mutation(store, () => mutate(plan.operation, plan.input), {
        prepare: () => {plan = prepare(); return plan.beforeWrite;}, readback: true,
      });
      return {...value, mutationResult: result, ...(readbackError ? {readbackError} : {})};
    }});
  } finally {owner.close();}
}

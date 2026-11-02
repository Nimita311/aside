import { GraphQLError, validateExecutionArgs, type ExecutionArgs } from 'graphql';
import { ExecutorThrowingOnIncremental } from 'graphql/execution/ExecutorThrowingOnIncremental.js';

export class GraphQLBudgetError extends GraphQLError {}

export interface ExecutionLimits {
  maxFields?: number;
  maxResponseBytes?: number;
  maxSerializedResponseBytes?: number;
}

export class ExecutionBudget {
  private controller = new AbortController();
  readonly signal: AbortSignal;
  constructor(readonly limits: ExecutionLimits, signal?: AbortSignal) {
    this.signal = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
  }

  check(): void { this.signal.throwIfAborted(); }

  exceed = (message: string): never => {
    this.check();
    const error = new GraphQLBudgetError(message);
    this.controller.abort(error);
    throw error;
  };

  // Count JSON incrementally before serialization can allocate an oversized
  // response. Results are plain JSON values; this includes keys and escaping.
  checkResponse(value: unknown): void {
    let bytes = 0;
    const add = (size: number) => {
      bytes += size;
      if (bytes > (this.limits.maxSerializedResponseBytes ?? 8 * 1024 * 1024)) {
        this.exceed('GraphQL serialized response limit exceeded. Select fewer fields or smaller pages.');
      }
    };
    const walk = (item: unknown): void => {
      this.check();
      if (typeof item === 'string') {
        // Raw UTF-8 is a lower bound on JSON string size. Reject before making
        // an escaped copy of a large diagnostic or other non-field string.
        const rawBytes = Buffer.byteLength(item, 'utf8');
        add(rawBytes + 2);
        add(Buffer.byteLength(JSON.stringify(item), 'utf8') - rawBytes - 2);
      } else if (item === null || typeof item !== 'object') {
        add(Buffer.byteLength(JSON.stringify(item) ?? 'null', 'utf8'));
      } else if (Array.isArray(item)) {
        add(2 + Math.max(0, item.length - 1));
        for (const child of item) walk(child);
      } else {
        add(2);
        let count = 0;
        for (const [key, child] of Object.entries(item)) {
          if (child === undefined) continue;
          add((count++ ? 1 : 0) + Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
          walk(child);
        }
      }
    };
    walk(value);
  }
}

// GraphQL's fallback resolver misses explicit resolvers (including introspection).
// Its ordinary field-error handling also keeps traversing nullable siblings after
// a throw. Keep this adapter tied to the pinned GraphQL version and exercise both
// synchronous traversal and asynchronous cancellation when upgrading it.
class BudgetExecutor extends ExecutorThrowingOnIncremental {
  private fields = 0;
  private textBytes = 0;
  constructor(args: ConstructorParameters<typeof ExecutorThrowingOnIncremental>[0], private budget: ExecutionBudget) {
    super(args);
  }

  override executeField(...args: Parameters<ExecutorThrowingOnIncremental['executeField']>) {
    this.budget.check();
    if (++this.fields > (this.budget.limits.maxFields ?? 100_000)) {
      this.budget.exceed('GraphQL response field limit exceeded. Reduce nesting or page sizes.');
    }
    return super.executeField(...args);
  }

  override completeLeafValue(...args: Parameters<ExecutorThrowingOnIncremental['completeLeafValue']>) {
    this.budget.check();
    const value = super.completeLeafValue(...args);
    if (typeof value === 'string') this.textBytes += Buffer.byteLength(value, 'utf8');
    if (this.textBytes > (this.budget.limits.maxResponseBytes ?? 8 * 1024 * 1024)) {
      this.budget.exceed('GraphQL response text limit exceeded. Select fewer bodies or smaller pages.');
    }
    return value;
  }

  override handleFieldError(...args: Parameters<ExecutorThrowingOnIncremental['handleFieldError']>) {
    if (args[0] instanceof GraphQLBudgetError) this.budget.exceed(args[0].message);
    // Unwind through every nullable field/list boundary instead of collecting
    // repeated errors or resolving another sibling after the request aborts.
    this.budget.check();
    return super.handleFieldError(...args);
  }
}

export function executeWithBudget(args: ExecutionArgs, budget: ExecutionBudget) {
  budget.check();
  const validated = validateExecutionArgs({ ...args, abortSignal: budget.signal });
  if (!('schema' in validated)) return { errors: validated };
  return new BudgetExecutor(validated, budget).executeRootSelectionSet();
}

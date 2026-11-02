import type { AutomationSource } from './scheduler.js';
import type { DelegationTarget } from './delegation.js';
import type { RunRecord } from './storage.js';

export interface DelegationRequest { source: AutomationSource; target: DelegationTarget; automatic: boolean }
export interface PreparedDelegation { source: AutomationSource }
export interface DelegationDispatchResult { run: RunRecord & {directory: string}; actionId: string }
export interface DelegationCallbacks {
  prepare(request: DelegationRequest): PreparedDelegation;
  complete(source: AutomationSource, run: RunRecord): string;
}

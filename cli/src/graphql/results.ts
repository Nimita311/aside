import { parseArtifactHandle } from '../core/artifact.js';
import type { MutationChange, MutationFailure, MutationResult } from '../mcp/tools/mutation-result.js';

type RecordKind = 'entry' | 'project' | 'action' | 'artifact' | 'instance';
export interface MutationPayloadIds {
  id?: string;
  createdProjectIds: string[];
  createdActionIds: string[];
}
interface OutcomeIds {
  id?: string;
  entryId?: string;
  createdProjectIds?: string[];
  createdActionIds?: string[];
}

/** Transport failure signals include a reported partial write, even without GraphQL execution errors. */
export function hasGraphQLProblems(result: {errors?: readonly unknown[]; extensions?: Record<string, unknown>}): boolean {
  const mutations = result.extensions?.mutations;
  return !!result.errors?.length || Array.isArray(mutations) && mutations.some(value => typeof value?.error === 'string' && value.error.length > 0);
}

function target(value: MutationChange | MutationFailure): string {
  const identity = value.kind ? `${value.kind}${value.id ? ` ${JSON.stringify(value.id)}` : ''}` : value.id ? JSON.stringify(value.id) : '';
  const fields = value.fields?.length ? ` [${value.fields.join(', ')}]` : '';
  const path = value.path ? ` (${value.path})` : '';
  return identity + fields + path;
}

/** A failed write with no confirmed durable effects must not return a payload. */
export function isFullMutationFailure(result: MutationResult): boolean {
  return result.changes.length === 0 && (result.failures.length > 0 || result.status !== 'SUCCEEDED');
}

/** Consolidate failures and known warnings without interpreting authored text. */
export function summarizeMutationError(result: MutationResult, options: {message?: string; warnings?: readonly string[]} = {}): string | null {
  const warnings = [...new Set((options.warnings ?? []).filter(Boolean))];
  const failures = [...new Set(result.failures.map(failure => `${target(failure)}${target(failure) ? ': ' : ''}${failure.message}`))];
  const message = options.message?.trim();
  if (message && !result.failures.some(failure => failure.message === message)) failures.unshift(message);
  if (!failures.length && !warnings.length && result.status === 'SUCCEEDED') return null;
  const lines: string[] = [];
  if (result.changes.length) {
    lines.push(failures.length || result.status !== 'SUCCEEDED' ? 'Partial failure. Confirmed changes:' : 'Confirmed changes:');
    const verbs = {CREATED: 'Created', UPDATED: 'Updated', REMOVED: 'Removed'};
    for (const change of result.changes) lines.push(`- ${verbs[change.effect]} ${target(change)}`);
  } else if (isFullMutationFailure(result)) lines.push('No changes were saved.');
  if (failures.length) lines.push('Failed:', ...failures.map(failure => `- ${failure}`));
  else if (result.status !== 'SUCCEEDED') lines.push('The mutation could not be completed.');
  if (warnings.length) lines.push('Warnings:', ...warnings.map(warning => `- ${warning}`));
  if (result.changes.length && result.recovery) lines.push(`Recovery: ${result.recovery}`);
  else if (result.changes.length && (failures.length || result.status !== 'SUCCEEDED')) {
    lines.push('Recovery: Read the saved records and files; preserve confirmed changes and retry only the incomplete steps.');
  }
  return lines.join('\n');
}

/** Resolve partial payload identities from the journal rather than response text. */
export function deriveMutationPayloadIds(kind: RecordKind, targetId: string | undefined, result: MutationResult, outcome: OutcomeIds = {}): MutationPayloadIds {
  const creates = (type: 'project' | 'action') => [...new Set(result.changes
    .filter(change => change.kind === type && change.effect === 'CREATED').map(change => change.id))];
  const confirmed = result.changes.filter(change => change.kind === kind && change.effect !== 'REMOVED');
  const outcomeId = kind === 'entry' ? outcome.entryId ?? outcome.id : outcome.id;
  let id: string | undefined = confirmed.find(change => change.id === outcomeId)?.id
    ?? confirmed.find(change => change.id === targetId)?.id ?? confirmed[0]?.id;
  if (id === undefined && kind === 'artifact' && targetId === undefined) {
    id = result.changes.filter(change => change.kind === 'attachment')
      .map(change => parseArtifactHandle(change.id)?.id).find(value => value !== undefined);
  }
  // Existing owners can still be read when only linked creates persisted. A
  // successful no-op may have no journal entries but a trusted handler identity.
  id ??= targetId ?? (result.status === 'SUCCEEDED' ? outcomeId : undefined);
  return {id, createdProjectIds: creates('project'), createdActionIds: creates('action')};
}

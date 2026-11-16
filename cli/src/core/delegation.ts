import { assertKnownKeys, mapping, validateRunDefinition, validateTimeout, type AutomationDefinition } from './automation.js';

// The action supplies scheduling; its automation accepts agent prompts only.
export type DelegationDefinition = Pick<AutomationDefinition, 'timeout'> & {
  run: Extract<AutomationDefinition['run'], {model: string}>;
};

export function assertDelegation(value: unknown): DelegationDefinition {
  const declaration = mapping(value, 'delegation');
  assertKnownKeys(declaration, ['run', 'timeout'], 'delegation');
  const timeout = validateTimeout(declaration.timeout);
  const run = validateRunDefinition(declaration.run);
  if (!('model' in run)) throw new Error('delegation.run must specify model and prompt; scripts are unsupported');
  return {run, ...(timeout === undefined ? {} : {timeout})};
}

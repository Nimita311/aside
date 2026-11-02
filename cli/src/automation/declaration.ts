import { mapping, validateDefinition, type AutomationDeclarations } from '../core/automation.js';
import { compileSchedule } from './schedule.js';

// Authoring validates the whole replacement before any record is written.
// Reads preserve invalid declarations from direct edits for diagnosis and repair.
export function assertAutomationDeclarations(value: unknown): AutomationDeclarations {
  const declarations = mapping(value, 'automations');
  for (const [name, raw] of Object.entries(declarations)) {
    if (!name.trim() || name.includes('\0')) throw new Error('Automation names must be nonblank text');
    try { const definition = validateDefinition(raw); compileSchedule(definition.schedule); }
    catch (error) { throw new Error(`automations.${name}: ${(error as Error).message}`); }
  }
  return structuredClone(declarations);
}

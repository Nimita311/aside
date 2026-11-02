import { GraphQLError } from 'graphql';
import { assertDelegation } from '../core/delegation.js';
import { assertAutomationDeclarations } from '../automation/declaration.js';
import { assertAutomationEdits } from '../mcp/tools/automation-edits.js';
import { assertLinkEdits, assertRelatedProjectEdits } from '../mcp/tools/link-edits.js';
import type { NewAction, NewProject } from '../mcp/tools/capture.js';
import { TOOL_SCHEMAS } from '../mcp/schemas.js';
import { assertScheduling } from '../core/scheduling.js';
import { artifactHandle, assertArtifactId } from '../core/artifact.js';
import { formatDate } from '../core/date.js';
import { toKebabCase } from '../core/slug.js';
import type { CreateArtifactArgs } from '../mcp/tools/artifact.js';

type Input = Record<string, any>;

export interface AutomationPromptRequest {id: string; create?: CreateArtifactArgs; now?: Date}
interface PromptInputs {now: Date; requests: AutomationPromptRequest[]}
const promptRequests = new WeakMap<object, AutomationPromptRequest[]>();

/** Inline definitions stay out of stored declarations and are committed with their owner. */
export function authoredAutomationPrompts(args: Input): readonly AutomationPromptRequest[] {
  return promptRequests.get(args) ?? [];
}

// Map typed validation paths, never message text or authored scalar values.
const publicFields: Record<string, string> = {
  body_file: 'bodyFile', content_file: 'contentFile', calendar_account: 'calendarAccount', remove_files: 'removeAttachments', files: 'attachments',
  related_projects: 'relatedProjects', projectEdits: 'projects', actionEdits: 'actions',
  relatedProjectEdits: 'relatedProjects', automationEdits: 'automations',
};

function publicInputPath(field: string, input: Input, path: PropertyKey[]): string {
  if (!path.length) return 'arguments';
  const [root, ...rest] = path;
  const name = String(root);
  const publicRoot = publicFields[name] ?? name;
  if (field === 'updateInstance' && Object.hasOwn(input.settings ?? {}, name)) return ['settings', name, ...rest].join('.');
  if (name === 'recurrence' && rest[0] === 'set_end') rest[0] = 'setEnd';
  if (field === 'updateProject' && name === 'related_projects') return ['relatedProjects', 'set', ...rest].join('.');
  if ((field === 'capture' || field === 'updateEntry') && ['projects', 'actions'].includes(publicRoot)) {
    const command = field === 'capture' ? undefined : name === publicRoot ? 'set' : String(rest.shift());
    const items = command === undefined ? input[publicRoot] : input[publicRoot]?.[command];
    const index = rest[0];
    if (typeof index === 'number' && items?.[index]?.create != null) {
      if (typeof rest[1] === 'string') rest[1] = publicFields[rest[1]] ?? rest[1];
      rest.splice(1, 0, 'create');
    }
    return [publicRoot, ...(command === undefined ? [] : [command]), ...rest].join('.');
  }
  return [publicRoot, ...rest].join('.');
}

function validateInput(field: string, operation: keyof typeof TOOL_SCHEMAS, values: Input, input: Input): void {
  const parsed = TOOL_SCHEMAS[operation].safeParse(values);
  if (parsed.success) return;
  const relevantBranches = (branches: any[][], path: PropertyKey[]): any[][] => {
    const value = path.reduce<any>((parent, key) => parent?.[key], values);
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const score = (issues: any[]) => [Number(issues.some(issue => issue.code === 'invalid_type' && !issue.path.length && issue.expected !== type)),
      issues.filter(issue => issue.code === 'unrecognized_keys' && !issue.path.length).reduce((count, issue) => count + issue.keys.length, 0)];
    const scores = branches.map(score);
    const best = [...scores].sort((a, b) => a[0] - b[0] || a[1] - b[1])[0];
    return branches.filter((_branch, index) => scores[index][0] === best[0] && scores[index][1] === best[1]);
  };
  const reasonsFor = (issues: any[], prefix: PropertyKey[] = []): string[] => issues.flatMap(issue => {
    const path = [...prefix, ...issue.path];
    // Native GraphQL alternatives are already selected. Report the matching
    // legacy union branch rather than complaints about its unused alternatives.
    const branches = issue.errors ?? issue.unionErrors?.map((error: any) => error.issues);
    if (branches) return reasonsFor(relevantBranches(branches, path).flat(), path);
    return [`${publicInputPath(field, input, path)}: ${issue.message}`];
  });
  throw new GraphQLError(`Invalid ${field} arguments: ${[...new Set(reasonsFor(parsed.error.issues))].join('; ')}`);
}

// These validators generate a fixed leading field path. Preserve every byte
// after that prefix, including authored job names and values in their errors.
function validateEdits<T>(validate: () => T, fields: Record<string, string>): T {
  try { return validate(); }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    for (const [stored, exposed] of Object.entries(fields)) {
      if (error.message.startsWith(stored) && /^[.: ]/.test(error.message.slice(stored.length))) {
        throw new GraphQLError(exposed + error.message.slice(stored.length));
      }
    }
    throw error;
  }
}

function object(value: unknown, field: string): Input {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GraphQLError(`${field} must be an input object.`);
  return value as Input;
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new GraphQLError(`${field} must be a list; use [] to clear it.`);
  return value;
}

// Rename only fields of known GraphQL inputs. Authored content stays verbatim.
function rename(input: Input, fields: Record<string, string>): Input {
  return Object.fromEntries(Object.entries(input).map(([field, value]) => [fields[field] ?? field, value]));
}

function recurrence(value: unknown): unknown {
  return value == null ? value : rename(object(value, 'recurrence'), {setEnd: 'set_end'});
}

function contentSource(input: Input, field: 'body' | 'content', required = false): void {
  const inline = input[field] !== undefined;
  const file = input[`${field}_file`] !== undefined;
  if (inline && file) throw new GraphQLError(`Provide either ${field} or ${field}File, not both.`);
  if (required && !inline && !file) throw new GraphQLError(`Provide ${field} or ${field}File.`);
}

function artifactInput(value: unknown): Input {
  const result = rename(object(value, 'create artifact'), {bodyFile: 'body_file', attachments: 'files', removeAttachments: 'remove_files'});
  contentSource(result, 'body');
  validateInput('createArtifact', 'create_artifact', result, object(value, 'create artifact'));
  return result;
}

function automationPrompt(value: unknown, prompts: PromptInputs): string | null {
  if (value === null) return null;
  const link = object(value, 'automation prompt');
  if (Object.keys(link).length !== 1 || (link.existingId == null && link.create == null)) {
    throw new GraphQLError('Automation prompt requires exactly one of existingId or create.');
  }
  let id: string, create: CreateArtifactArgs | undefined;
  if (Object.hasOwn(link, 'existingId')) {
    if (typeof link.existingId !== 'string') throw new GraphQLError('Automation prompt existingId must be an Artifact ID.');
    id = link.existingId;
  } else {
    create = artifactInput(link.create) as CreateArtifactArgs;
    id = `${formatDate(prompts.now)}-${toKebabCase(create.name)}`;
  }
  try {assertArtifactId(id);} catch (error) {throw new GraphQLError((error as Error).message);}
  prompts.requests.push({id, ...(create ? {create, now: prompts.now} : {})});
  return artifactHandle(id);
}

function automationMap(value: unknown, prompts: PromptInputs, patch = false): Input {
  const definitions: Input = Object.create(null);
  for (const raw of list(value, patch ? 'automations.patch' : 'automations')) {
    const {name, ...definition} = object(raw, 'automation');
    if (typeof name !== 'string' || !name.trim() || name.includes('\0')) throw new GraphQLError('Automation names must be nonblank text.');
    if (Object.hasOwn(definitions, name)) throw new GraphQLError(`Duplicate automation name: ${name}.`);
    if (definition.run != null) {
      const run = {...object(definition.run, 'automation.run')};
      if (Object.hasOwn(run, 'prompt')) run.prompt = automationPrompt(run.prompt, prompts);
      definition.run = run;
    }
    definitions[name] = definition;
  }
  return patch ? definitions : assertAutomationDeclarations(definitions);
}

function createProject(value: unknown, prompts: PromptInputs): Input {
  const result = rename(object(value, 'create project'), {bodyFile: 'body_file', relatedProjects: 'related_projects'});
  if (Object.hasOwn(result, 'automations')) result.automations = automationMap(result.automations, prompts);
  contentSource(result, 'body');
  return result;
}

function delegation(value: unknown, prompts: PromptInputs): Input | null {
  if (value === null) return null;
  const definition = {...object(value, 'delegation')};
  const run = {...object(definition.run, 'delegation.run')};
  if (Object.hasOwn(run, 'prompt')) run.prompt = automationPrompt(run.prompt, prompts);
  return assertDelegation({...definition, run});
}

function createAction(value: unknown, prompts: PromptInputs): Input {
  const result = rename(object(value, 'create action'), {bodyFile: 'body_file', calendarAccount: 'calendar_account'});
  if (Object.hasOwn(result, 'delegation')) result.delegation = delegation(result.delegation, prompts);
  assertScheduling(result);
  if (result.recurrence !== undefined && result.scheduled !== undefined) throw new GraphQLError('A recurrence template cannot also have scheduled set.');
  contentSource(result, 'body');
  return result;
}

function links(value: unknown, kind: 'projects' | 'actions', prompts: PromptInputs): (string | NewProject | NewAction)[] {
  return list(value, kind).map(raw => {
    const link = object(raw, `${kind} link`);
    if (Object.keys(link).length !== 1 || (link.existingId == null && link.create == null)) {
      throw new GraphQLError(`${kind} links require exactly one of existingId or create.`);
    }
    if (Object.hasOwn(link, 'existingId')) {
      if (typeof link.existingId !== 'string' || !link.existingId.trim()) throw new GraphQLError(`${kind}.existingId must be a nonblank ID.`);
      return link.existingId;
    }
    return (kind === 'projects' ? createProject(link.create, prompts) : createAction(link.create, prompts)) as NewProject | NewAction;
  });
}

// Explicit replacement and incremental edits have deliberately distinct names
// inside one edit object. Even empty/null incremental commands cannot be mixed
// with set: the client should author a single unambiguous operation.
function hasSet(value: Input, field: string): boolean {
  if (!Object.hasOwn(value, 'set')) return false;
  if (Object.keys(value).some(key => key !== 'set')) throw new GraphQLError(`${field}.set is exclusive with incremental edits.`);
  list(value.set, `${field}.set`);
  return true;
}

function entryLinks(input: Input, result: Input, kind: 'projects' | 'actions', prompts: PromptInputs): void {
  delete result[kind];
  if (input[kind] == null) return;
  const edit = object(input[kind], kind);
  if (hasSet(edit, kind)) {
    const refs = links(edit.set, kind, prompts);
    validateEdits(() => assertLinkEdits({add: refs}, kind, prompts.now), {[`${kind}.add`]: `${kind}.set`});
    result[kind] = refs;
    return;
  }
  const normalized = {...edit, ...(edit.add == null ? {} : {add: links(edit.add, kind, prompts)})};
  assertLinkEdits(normalized, kind, prompts.now);
  result[kind === 'projects' ? 'projectEdits' : 'actionEdits'] = normalized;
}

function relatedProjects(input: Input, result: Input): void {
  delete result.relatedProjects;
  if (input.relatedProjects == null) return;
  const edit = object(input.relatedProjects, 'relatedProjects');
  if (hasSet(edit, 'relatedProjects')) {
    validateEdits(() => assertRelatedProjectEdits({upsert: edit.set}), {'relatedProjectEdits.upsert': 'relatedProjects.set'});
    result.related_projects = edit.set;
  } else {
    validateEdits(() => assertRelatedProjectEdits(edit), {relatedProjectEdits: 'relatedProjects'});
    result.relatedProjectEdits = {...edit};
  }
}

function automations(input: Input, result: Input, prompts: PromptInputs): void {
  delete result.automations;
  if (input.automations == null) return;
  const edit = object(input.automations, 'automations');
  if (hasSet(edit, 'automations')) {
    result.automations = automationMap(edit.set, prompts);
    return;
  }
  const normalized = {...edit,
    ...(edit.upsert == null ? {} : {upsert: automationMap(edit.upsert, prompts)}),
    ...(edit.patch == null ? {} : {patch: automationMap(edit.patch, prompts, true)}),
  };
  result.automationEdits = validateEdits(() => assertAutomationEdits(normalized), {automationEdits: 'automations'});
}

function assertStatusCommand(input: Input): void {
  if (!Object.hasOwn(input, 'status')) return;
  const status = input.status;
  if (status !== null && !['backlog', 'scheduled', 'done', 'cancelled'].includes(status)) throw new GraphQLError('status must be BACKLOG, SCHEDULED, DONE, CANCELLED, or null.');
  if ((status === 'backlog' || status === null) && input.scheduled != null) throw new GraphQLError(`${status === null ? 'A template' : 'BACKLOG'} cannot also have scheduled set.`);
  if (status === 'scheduled' && Object.hasOwn(input, 'scheduled') && !input.scheduled) throw new GraphQLError('SCHEDULED requires a non-null scheduled time.');
  if (status !== null && input.recurrence?.append != null) throw new GraphQLError('A recurrence template must have null status.');
}

export interface ActionStatusSnapshot {
  recurrence?: unknown;
  scheduled?: string;
  occurrence?: unknown;
}

const operations: Record<string, keyof typeof TOOL_SCHEMAS> = {
  capture: 'capture', updateEntry: 'update_entry', updateProject: 'update_project',
  updateInstance: 'update_instance', updateAction: 'update_action', updateOccurrence: 'update_occurrence',
  createArtifact: 'create_artifact', updateArtifact: 'update_artifact',
};

function preflight(field: string, input: Input, args: Input, publicInput: Input): void {
  const operation = operations[field];
  if (!operation) return;
  const values: Input = {...input, ...(args.id === undefined ? {} : {id: args.id})};
  delete values.status;
  validateInput(field, operation, values, publicInput);
  if (field === 'updateAction' || field === 'updateOccurrence') {
    assertScheduling(Object.fromEntries(['scheduled', 'deadline', 'duration', 'timezone']
      .filter(key => values[key] != null).map(key => [key, values[key]])));
  }
  contentSource(input, 'body');
  contentSource(input, 'content', field === 'capture');
  if (field === 'updateOccurrence' && !Object.entries(input).some(([key, value]) => !['template', 'original'].includes(key) && value !== undefined)) {
    throw new GraphQLError('An occurrence edit is required; use actions through query to read projections.');
  }
}

/** Translate query-oriented lifecycle commands after resolving the action. */
export function normalizeActionStatus(input: Input, current: ActionStatusSnapshot): Input {
  assertStatusCommand(input);
  const result = {...input};
  if (current.occurrence != null && input.recurrence != null) throw new GraphQLError('Recurrence commands apply to the template action, not an occurrence.');
  const template = Array.isArray(current.recurrence) || input.recurrence?.append != null;
  if (Object.hasOwn(input, 'status')) {
    const status = input.status;
    if (template && status !== null) throw new GraphQLError('A recurrence template must have null status.');
    if (!template && status === null) throw new GraphQLError('Only recurrence templates have null status; use BACKLOG or SCHEDULED to reactivate an action.');
    if (status === null || status === 'backlog') {
      result.scheduled = null;
      result.resolution = null;
    } else if (status === 'scheduled') {
      const scheduled = Object.hasOwn(input, 'scheduled') ? input.scheduled : current.scheduled;
      if (!scheduled) throw new GraphQLError('SCHEDULED requires a scheduled time; supply scheduled in this input.');
      result.resolution = null;
    } else result.resolution = status;
    delete result.status;
  }
  return result;
}

/** Normalize only the selected mutation's typed authoring inputs before writes. */
export function normalizeMutationArguments(field: string, args: Input, options: {now?: Date} = {}): Input {
  if (args.input == null) return {...args};
  const input = object(args.input, `${field}.input`);
  const prompts: PromptInputs = {now: options.now ?? new Date(), requests: []};
  const result = rename(input, {bodyFile: 'body_file', contentFile: 'content_file', calendarAccount: 'calendar_account', attachments: 'files', removeAttachments: 'remove_files'});
  if (field === 'capture') {
    for (const kind of ['projects', 'actions'] as const) if (input[kind] != null) result[kind] = links(input[kind], kind, prompts);
  } else if (field === 'updateEntry') {
    for (const kind of ['projects', 'actions'] as const) entryLinks(input, result, kind, prompts);
  } else if (field === 'updateProject') {
    relatedProjects(input, result);
    automations(input, result, prompts);
  } else if (field === 'updateInstance') {
    automations(input, result, prompts);
    delete result.settings;
    if (input.settings != null) Object.assign(result, object(input.settings, 'settings'));
  } else if (field === 'updateAction' || field === 'updateOccurrence') {
    if (Object.hasOwn(input, 'delegation')) result.delegation = delegation(input.delegation, prompts);
    if (Object.hasOwn(input, 'recurrence')) result.recurrence = recurrence(input.recurrence);
    assertStatusCommand(result);
  }
  preflight(field, result, args, input);
  const normalized = {...args, input: result};
  if (prompts.requests.length) promptRequests.set(normalized, prompts.requests);
  return normalized;
}

/** Explicitly authored selections only; arbitrary scalar content is not scanned. */
export function authoredAutomationModels(args: Input): string[] {
  const selections: string[] = [];
  const owner = (input: Input): void => {
    if (typeof input.delegation?.run?.model === 'string') selections.push(input.delegation.run.model);
    const declarations = [input.automations, input.automationEdits?.upsert, input.automationEdits?.patch];
    for (const jobs of declarations) for (const job of Object.values(jobs ?? {}) as Input[]) {
      if (typeof job?.run?.model === 'string') selections.push(job.run.model);
    }
  };
  const input = args.input ?? args;
  owner(input);
  for (const project of [...(input.projects ?? []), ...(input.projectEdits?.add ?? []), ...(input.actions ?? []), ...(input.actionEdits?.add ?? [])]) {
    if (typeof project === 'object' && project !== null) owner(project);
  }
  return selections;
}

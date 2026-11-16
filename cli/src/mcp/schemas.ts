import { assertAutomationDeclarations } from '../automation/declaration.js';
import { z } from 'zod';
import { assertDelegation } from '../core/delegation.js';
import { Temporal } from '@js-temporal/polyfill';
import { CALENDAR_NAME_RULE, isCalendarName } from '../core/calendar-name.js';
import { assertRecurrence } from '../core/recurrence.js';
import { isCalendarDate, isWallMinute } from '../core/scheduling.js';
import { parseLocationHandle, LOCATION_HANDLE_RULE } from '../core/location-reference.js';
import { assertWebappSidebar } from '../core/webapp-config.js';
import { assertAutomationEdits } from '../core/automation-edits.js';

const calendarNameSchema = z.string().refine(isCalendarName, CALENDAR_NAME_RULE);
const locationSchema = z.string().refine(value => parseLocationHandle(value) !== null, LOCATION_HANDLE_RULE);

// Core assertions state each rule once; a schema reports the failure as its issue.
const asserting = (assert: (value: any) => unknown) => (value: unknown, ctx: z.RefinementCtx) => {
  try { assert(value); }
  catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); }
};

const automationsSchema = z.record(z.string(), z.unknown()).superRefine(asserting(assertAutomationDeclarations));

const delegationSchema = z.record(z.string(), z.unknown()).superRefine(asserting(assertDelegation));

const automationEditsSchema = z.object({
  upsert: z.record(z.string(), z.unknown()).nullable().optional(),
  patch: z.record(z.string(), z.unknown()).nullable().optional(),
  remove: z.array(z.string()).nullable().optional(),
}).strict().superRefine(asserting(assertAutomationEdits)).nullable().optional();

const recurrenceScheduleSchema = z.object({ dtstart: z.string(), rrule: z.string(), timezone: z.string().optional() }).strict();
const recurrenceSchema = z.array(recurrenceScheduleSchema).superRefine(asserting(assertRecurrence));
// One schedule obeys the list's rules; report its issues at the schedule's own path.
const scheduleIssues = (schedule: unknown, ctx: z.RefinementCtx) => {
  const parsed = recurrenceSchema.safeParse([schedule]);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: issue.path.slice(1) });
};
const appendedScheduleSchema = recurrenceScheduleSchema.superRefine(scheduleIssues);
const recurrenceSelectorSchema = z.object({ dtstart: z.string(), timezone: z.string().optional() }).strict()
  .superRefine((value, ctx) => scheduleIssues({ ...value, rrule: 'FREQ=DAILY' }, ctx));
const recurrenceEndSchema = z.object({
  schedule: recurrenceSelectorSchema,
  at: z.string().datetime({ offset: true }).refine(value => {
    if (!isWallMinute(value.slice(0, 16)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
    try { Temporal.Instant.from(value); return true; } catch { return false; }
  }, 'at must be a valid ISO timestamp with Z or an explicit offset').optional(),
}).strict();
const recurrenceMutationSchema = z.union([
  z.object({ append: appendedScheduleSchema }).strict(),
  z.object({ set_end: recurrenceEndSchema }).strict(),
  z.object({ remove: recurrenceSelectorSchema }).strict(),
]);

const relatedProjectsSchema = z.array(z.object({ project: z.string(), description: z.string() }).strict());
const relatedProjectEditsSchema = z.object({
  upsert: relatedProjectsSchema.nullable().optional(),
  remove: z.array(z.string().min(1)).nullable().optional(),
}).strict().nullable().optional();

const bodyFileSchema = z.string().optional();
const contentFileSchema = z.string().optional();
const artifactFilesSchema = z.array(z.object({
  source: z.string(),
  filename: z.string().optional(),
}).strict()).optional();

// New-entity objects accepted inside `projects`/`actions` link lists — shared by
// capture and updateEntry, which create projects and actions identically.
const newProjectSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string().optional(),
  body_file: bodyFileSchema,
  automations: automationsSchema.optional(),
  related_projects: relatedProjectsSchema.optional(),
}).strict();

// Detail/pagination arguments of the artifact query.
const queryPageSchema = {
  detail: z.enum(['index', 'metadata', 'full']).optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).optional(),
};

function queryDateSchema() {
  return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isCalendarDate, 'Use a valid calendar date').optional();
}

function querySearchSchema() {
  return z.string().optional();
}

const newActionSchema = z.object({
  delegation: delegationSchema.optional(),
  recurrence: recurrenceSchema.optional(),
  name: z.string(),
  description: z.string(),
  body: z.string().optional(),
  body_file: bodyFileSchema,
  scheduled: z.string().optional(),
  deadline: z.string().optional(),
  calendar: calendarNameSchema.optional(),
  calendar_account: z.string().optional(),
  duration: z.string().optional(),
  timezone: z.string().optional(),
  location: locationSchema.optional(),
}).strict();

// A link list names existing records by ID and declares new ones inline.
const projectLinksSchema = z.array(z.union([z.string(), newProjectSchema]));
const actionLinksSchema = z.array(z.union([z.string(), newActionSchema]));

const graphQLArgs = z.object({
  document: z.string().min(1).max(64_000).describe('Standard GraphQL operation document. Use introspection to discover types, fields, filters, and mutation inputs.'),
  variables: z.record(z.string(), z.unknown()).optional().describe('GraphQL variable values as a JSON object.'),
  operationName: z.string().optional().describe('Operation name; required when the document contains multiple operations.'),
}).strict();

// Input contracts of the MCP tools and daemon operations; never strip unsupported fields.
export const TOOL_SCHEMAS = {
  query: graphQLArgs,
  mutate: graphQLArgs,
  create_instance: z.object({
      path: z.string(),
      name: z.string().min(1),
      description: z.string().min(1),
      body: z.string().optional(),
      tutorial: z.boolean().optional(),
    }).strict(),
  update_instance: z.object({
    webapp: z.object({
      sidebar: z.array(z.unknown()).superRefine(asserting(assertWebappSidebar)).optional(),
    }).strict().optional(),
    automations: automationsSchema.nullable().optional(),
    automationEdits: automationEditsSchema,
    body: z.string().optional(),
    scheduledEventTitlePrefix: z.string().nullable().optional(),
    doneEventTitlePrefix: z.string().nullable().optional(),
  }).strict(),
  query_entries: z.object({
      ids: z.array(z.string()).optional(),
      projects: z.array(z.string()).optional(),
      actions: z.array(z.string()).optional(),
      created_from: queryDateSchema(),
      created_to: queryDateSchema(),
      search: querySearchSchema(),
    }).strict(),
  update_occurrence: z.object({ delegation: delegationSchema.nullable().optional(), template: z.string(), original: z.string(), name: z.string().min(1).optional(), scheduled: z.string().nullable().optional(), timezone: z.string().nullable().optional(), duration: z.string().nullable().optional(), location: locationSchema.nullable().optional(), calendar: calendarNameSchema.nullable().optional(), calendar_account: z.string().nullable().optional(), deadline: z.string().nullable().optional(), resolution: z.enum(['done', 'cancelled']).nullable().optional(), body: z.string().optional(), body_file: bodyFileSchema, description: z.string().optional() }).strict(),
  query_actions: z.object({
      ids: z.array(z.string()).optional(),
      projects: z.array(z.string()).optional(),
      created_from: queryDateSchema(),
      created_to: queryDateSchema(),
      scheduled_from: queryDateSchema(),
      scheduled_to: queryDateSchema(),
      deadline_from: queryDateSchema(),
      deadline_to: queryDateSchema(),
      status: z.array(z.enum(['backlog', 'scheduled', 'done', 'cancelled'])).optional(),
      search: querySearchSchema(),
    }).strict(),
  query_projects: z.object({
      ids: z.array(z.string()).optional(),
      related_to: z.array(z.string()).optional(),
      created_from: queryDateSchema(),
      created_to: queryDateSchema(),
      ended_from: queryDateSchema(),
      ended_to: queryDateSchema(),
      status: z.enum(['open', 'closed']).optional(),
      search: querySearchSchema(),
    }).strict(),
  query_artifacts: z.object({
      ids: z.array(z.string()).optional(),
      projects: z.array(z.string()).optional(),
      actions: z.array(z.string()).optional(),
      created_from: queryDateSchema(),
      created_to: queryDateSchema(),
      search: querySearchSchema(),
      ...queryPageSchema,
    }).strict(),
  create_artifact: z.object({
      name: z.string().min(1),
      description: z.string().min(1),
      body: z.string().optional(),
      body_file: bodyFileSchema,
      files: artifactFilesSchema,
    }).strict(),
  update_artifact: z.object({
      id: z.string(),
      name: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      body: z.string().optional(),
      body_file: bodyFileSchema,
      files: artifactFilesSchema,
      remove_files: z.array(z.string()).optional(),
    }).strict(),
  capture: z.object({
      content: z.string().optional(),
      content_file: contentFileSchema,
      description: z.string(),
      projects: projectLinksSchema.optional(),
      actions: actionLinksSchema.optional(),
    }).strict(),
  update_action: z.object({
      delegation: delegationSchema.nullable().optional(),
      recurrence: recurrenceMutationSchema.optional(),
      id: z.string(),
      name: z.string().refine(value => value.trim().length > 0, 'name must be nonblank').optional(),
      scheduled: z.string().nullable().optional(),
      deadline: z.string().nullable().optional(),
      resolution: z.enum(['done', 'cancelled']).nullable().optional(),
      calendar: calendarNameSchema.nullable().optional(),
      calendar_account: z.string().nullable().optional(),
      duration: z.string().nullable().optional(),
      timezone: z.string().nullable().optional(),
      location: locationSchema.nullable().optional(),
      body: z.string().optional(),
      body_file: bodyFileSchema,
      description: z.string().optional(),
    }).strict(),
  update_project: z.object({
      automations: automationsSchema.nullable().optional(),
      automationEdits: automationEditsSchema,
      id: z.string(),
      name: z.string().refine(value => value.trim().length > 0, 'name must be nonblank').optional(),
      ended: z.string().refine(isWallMinute, 'ended must be a real floating time YYYY-MM-DDTHH:mm').nullable().optional(),
      related_projects: relatedProjectsSchema.nullable().optional(),
      relatedProjectEdits: relatedProjectEditsSchema,
      body: z.string().optional(),
      body_file: bodyFileSchema,
      description: z.string().optional(),
    }).strict(),
  update_entry: z.object({
      id: z.string(),
      content: z.string().optional(),
      content_file: contentFileSchema,
      description: z.string().optional(),
      projects: projectLinksSchema.nullable().optional(),
      actions: actionLinksSchema.nullable().optional(),
      projectEdits: z.object({
        add: projectLinksSchema.nullable().optional(),
        remove: z.array(z.string().min(1)).nullable().optional(),
      }).strict().nullable().optional(),
      actionEdits: z.object({
        add: actionLinksSchema.nullable().optional(),
        remove: z.array(z.string().min(1)).nullable().optional(),
      }).strict().nullable().optional(),
    }).strict(),
  show: z.object({
      source: z.string().min(1).optional(),
      search: z.string().optional(),
      project: z.string().min(1).optional(),
      action: z.string().min(1).optional(),
      detail: z.boolean().optional(),
      entry: z.string().min(1).optional(),
      artifact: z.string().min(1).optional(),
      filename: z.string().min(1).optional(),
      asset: z.string().min(1).optional(),
    }).strict(),
} as const;

export function validateToolArgs(name: string, args: unknown): any {
  if (!Object.hasOwn(TOOL_SCHEMAS, name)) throw new Error(`Unknown operation: ${name}`);
  const parsed = TOOL_SCHEMAS[name as keyof typeof TOOL_SCHEMAS].safeParse(args === undefined ? {} : args);
  if (!parsed.success) {
    function reasonsFor(issues: any[], prefix: PropertyKey[] = []): string[] {
      return issues.flatMap(issue => {
        const path = [...prefix, ...issue.path];
        if (issue.unionErrors) return reasonsFor(issue.unionErrors.flatMap((error: any) => error.issues));
        if (issue.errors) return reasonsFor(issue.errors.flat(), path);
        return [`${path.length ? path.join('.') : 'arguments'}: ${issue.message}`];
      });
    }
    const reasons = [...new Set(reasonsFor(parsed.error.issues))];
    throw new Error(`Invalid ${name} arguments: ${reasons.join('; ')}`);
  }
  return parsed.data;
}

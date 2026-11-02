import { assertAutomationDeclarations } from '../automation/declaration.js';
import { z } from 'zod';
import { assertDelegation } from '../core/delegation.js';
import { Temporal } from '@js-temporal/polyfill';
import { CALENDAR_NAME_RULE, isCalendarName } from '../core/calendar-name.js';
import { assertRecurrence } from '../core/recurrence.js';
import { isCalendarDate, isWallMinute } from '../core/scheduling.js';
import { assertAutomationEdits } from './tools/automation-edits.js';

const calendarNameSchema = z.string().refine(isCalendarName, CALENDAR_NAME_RULE);

const automationsSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  try { assertAutomationDeclarations(value); }
  catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); }
}).describe('Complete named automation map: each value has schedule (cron with optional timezone; rrule with dtstart and optional timezone; or at with offset), run (script/args or model/prompt), optional enabled, timeout, overlap. Model is a discovered CODEX_* or CLAUDE_* selection, or a name in instance-root .aside execution.models. Use query_models or GraphQL models for choices. Prompt is a direct primary artifact handle ("#artifact/YYYY-MM-DD-slug"); literal text, objects, and attachment handles are rejected. Replaces the full map; preserve other named jobs.');

const delegationSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
  try { assertDelegation(value); }
  catch (error) { ctx.addIssue({code: 'custom', message: (error as Error).message}); }
}).describe('Agent delegation: run with model and a direct primary artifact prompt handle, optional timeout (default PT30M). Follows action scheduling; templates supply it to projections.');

const automationEditsSchema = z.object({
  upsert: z.record(z.string(), z.unknown()).nullable().optional(),
  patch: z.record(z.string(), z.unknown()).nullable().optional(),
  remove: z.array(z.string()).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  try { assertAutomationEdits(value); }
  catch (error) { ctx.addIssue({code: 'custom', message: (error as Error).message}); }
}).nullable().optional().describe('Edit only named automation jobs. Patch updates supplied fields on existing jobs, recursively merging schedule/run; omitted fields and saved unavailable model choices are preserved, null removes optional fields. Upsert validates and replaces complete jobs; remove deletes names. Each name may appear in only one operation. Untouched jobs are preserved without validation. Null or empty edits preserve the map. Mutually exclusive with a supplied automations replacement.');

const recurrenceScheduleSchema = z.object({ dtstart: z.string(), rrule: z.string(), timezone: z.string().optional() }).strict();
const recurrenceSchema = z.array(recurrenceScheduleSchema).superRefine((value, ctx) => {
  try { assertRecurrence(value); } catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); }
}).describe('Initial ordered nonoverlapping RRULE history for a new template action; [] defines a dormant template. Each schedule has dtstart (date or minute wall time), optional IANA timezone, and rrule with native UNTIL or COUNT. Existing schedules use update_action recurrence commands.');
const appendedScheduleSchema = recurrenceScheduleSchema.superRefine((value, ctx) => {
  const parsed = recurrenceSchema.safeParse([value]);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: issue.path.slice(1) });
}).describe('One future RRULE schedule. dtstart is a date or minute wall time; optional timezone is an IANA zone. The server closes the previous schedule before this start and preserves past occurrences.');
const recurrenceSelectorSchema = z.object({ dtstart: z.string(), timezone: z.string().optional() }).strict().superRefine((value, ctx) => {
  const parsed = recurrenceSchema.safeParse([{ ...value, rrule: 'FREQ=DAILY' }]);
  if (!parsed.success) for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: issue.path.slice(1) });
}).describe('Exact schedule identity: its authored dtstart and timezone, or omit timezone for a floating or all-day schedule.');
const recurrenceEndSchema = z.object({
  schedule: recurrenceSelectorSchema,
  at: z.string().datetime({ offset: true }).refine(value => {
    if (!isWallMinute(value.slice(0, 16)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
    try { Temporal.Instant.from(value); return true; } catch { return false; }
  }, 'at must be a valid ISO timestamp with Z or an explicit offset').optional().describe('Exclusive end instant with Z or an explicit offset; omit to use the server clock. The server derives native UNTIL. Extending may expose past occurrences only when each already has a saved action.'),
}).strict();
const recurrenceMutationSchema = z.union([
  z.object({ append: appendedScheduleSchema }).strict(),
  z.object({ set_end: recurrenceEndSchema }).strict(),
  z.object({ remove: recurrenceSelectorSchema }).strict(),
]).describe('Exactly one recurrence command: append a future schedule, set_end the selected schedule (at defaults to now), or remove the selected schedule. Saved occurrences remain unchanged; new unsaved past occurrences and whole-list replacement are rejected.');

const relatedProjectsSchema = z.array(z.object({ project: z.string(), description: z.string() }).strict());
const relatedProjectEditsSchema = z.object({
  upsert: relatedProjectsSchema.nullable().optional(),
  remove: z.array(z.string().min(1)).nullable().optional(),
}).strict().nullable().optional().describe('Patch outgoing project relationships by project ID. Upsert sets only supplied relationship descriptions, remove deletes only these IDs; omitted/null/empty lists preserve. Exclusive with related_projects replacement.');

const bodyFileSchema = z.string().optional().describe('Absolute path to a regular UTF-8 Markdown file readable by this server. Its entire text supplies the body; metadata is not parsed. Mutually exclusive with body. An empty file supplies an empty body.');
const contentFileSchema = z.string().optional().describe('Absolute path to a regular UTF-8 Markdown file readable by this server. Its entire text supplies the entry content; metadata is not parsed. Mutually exclusive with content. An empty file supplies empty content.');
const artifactFilesSchema = z.array(z.object({
  source: z.string().describe('Absolute path to a readable regular file on this server. The source is copied and preserved; any format is supported.'),
  filename: z.string().optional().describe('Attachment filename. Defaults to the source basename; must be a single filename.'),
}).strict()).optional().describe('Files to import as artifact attachments. On update, adds or replaces only these files; omission or [] leaves attachments unchanged. HTML imports grant scripts read-only access to records across the selected instance when previewed; scripts can send that data externally. Use external iframe embeds for untrusted pages.');

// New-entity objects accepted inside `projects`/`actions` link lists — shared by
// capture and update_entry, which create projects and actions identically.
const newProjectSchema = z.object({
  name: z.string().describe('Display name for the new project'),
  description: z.string().describe('One-line index description of the project'),
  body: z.string().optional().describe('Markdown body with goals, constraints, context'),
  body_file: bodyFileSchema,
  automations: automationsSchema.optional(),
  related_projects: relatedProjectsSchema.optional().describe('Links to related project IDs with relationship descriptions'),
}).strict();

// Detail/pagination arguments shared by query tools.
const queryPageSchema = {
  detail: z.enum(['index', 'metadata', 'full']).optional().describe('index (default): ID + description. metadata: all fields, no body. full: fields + body.'),
  offset: z.number().int().nonnegative().optional().describe('Starting index (nonnegative integer, default 0). Continue using the response next_offset; null means the last page.'),
  limit: z.number().int().min(1).max(100).optional().describe('Max results (integer from 1 to 100, default 20). Header N of M reports N returned on this page and M total matches before pagination. Use limit: 1 for counts; repeat queries for groups expressible by filters, or page the needed records for other aggregates. Counts may be incomplete if parsing warnings appear.'),
};

function queryDateSchema(description: string) {
  return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine(isCalendarDate, 'Use a valid calendar date').optional().describe(description);
}

function querySearchSchema(description: string) {
  return z.string().optional().describe('JavaScript/ECMAScript regex compiled with the i flag (case-insensitive). Pass the pattern without /.../ delimiters or flags (e.g. foo|bar). ' + description);
}

const newActionSchema = z.object({
  delegation: delegationSchema.optional(),
  recurrence: recurrenceSchema.optional(),
  name: z.string().describe('Short display name — the calendar event\'s title.'),
  description: z.string().describe('One-line index description. Included in the calendar event\'s notes.'),
  body: z.string().optional().describe('Details and context (markdown) — included in the calendar event\'s notes.'),
  body_file: bodyFileSchema,
  scheduled: z.string().optional().describe('When to do it (authored wall time with minute precision, floating unless qualified by timezone; or date-only for all-day work). Only if user provided a date — omit for backlog. Required to sync to calendar.'),
  deadline: z.string().optional().describe('Hard deadline (local ISO 8601 with minute precision, or date-only when no time was specified). Included in the calendar event\'s notes. Only if user stated one.'),
  calendar: calendarNameSchema.optional().describe('Nonblank readable calendar name. Must resolve uniquely, alone or with calendar_account. Required to sync to calendar.'),
  calendar_account: z.string().optional().describe('Readable account name to disambiguate calendar. Omit for a uniquely named calendar; the name/account pair must be unique. No hidden calendar IDs.'),
  duration: z.string().optional().describe('Positive fixed ISO duration in whole minutes (e.g. PT1H, P1D = 24 elapsed hours across clock changes). Only if the user gave a length.'),
  timezone: z.string().optional().describe('Named IANA time zone for timed scheduled (e.g. Asia/Tokyo). Omit for floating time; all-day dates ignore it. Only if the user specified one.'),
}).strict();

const graphQLArgs = z.object({
  document: z.string().min(1).max(64_000).describe('Standard GraphQL operation document. Use introspection to discover types, fields, filters, and mutation inputs.'),
  variables: z.record(z.string(), z.unknown()).optional().describe('GraphQL variable values as a JSON object.'),
  operationName: z.string().optional().describe('Operation name; required when the document contains multiple operations.'),
}).strict();

// Shared by MCP registration and the daemon; never strip unsupported fields.
export const TOOL_SCHEMAS = {
  query: graphQLArgs,
  mutate: graphQLArgs,
  select_instance: z.object({
      path: z.string().describe('Absolute path to the instance\'s data directory'),
    }).strict(),
  create_instance: z.object({
      path: z.string().describe('Absolute path for the new instance. If the user gave no location, use a directory named `aside`.'),
      name: z.string().min(1).describe('Display name for the instance'),
      description: z.string().min(1).describe('One-line summary of what this instance is for — helps agents pick among instances'),
      body: z.string().optional().describe('Free-form manifest body: per-instance instructions the agent loads on entry. Include only instructions the user actually stated.'),
      tutorial: z.boolean().optional().describe('If true, also create the "Meet Aside" guided-tour project, starter actions, and a seeded first entry. Default false (empty instance).'),
    }).strict(),
  list_instances: z.object({}).strict(),
  query_instance: z.object({}).strict(),
  query_models: z.object({refresh: z.boolean().optional().describe('Refresh the installed runtime/vendor catalog; omit to use cached discovery when execution context is unchanged.')}).strict(),
  update_instance: z.object({
    recurrenceLookaheadDays: z.number().int().nonnegative().optional(),
    automations: automationsSchema.nullable().optional().describe('Replace the selected instance automation map in aside.md; omit to preserve, null or {} to clear.'),
    automationEdits: automationEditsSchema,
    body: z.string().optional().describe('Replace instance instructions; omit to preserve or use an empty string to clear.'),
    scheduledEventTitlePrefix: z.string().nullable().optional().describe('Calendar scheduled-action title prefix; omit to preserve, empty string for no prefix, null to restore the default.'),
    doneEventTitlePrefix: z.string().nullable().optional().describe('Calendar completed-action title prefix; omit to preserve, empty string for no prefix, null to restore the default.'),
  }).strict(),
  query_entries: z.object({
      ids: z.array(z.string()).optional().describe('Exact entry IDs (created timestamps). Omit = no filter; [] matches nothing.'),
      projects: z.array(z.string()).optional().describe('Filter by project IDs. Omit = no filter; [] = entries with no project.'),
      actions: z.array(z.string()).optional().describe('Filter by action IDs. Omit = no filter; [] = entries with no action.'),
      created_from: queryDateSchema('Start date inclusive (YYYY-MM-DD)'),
      created_to: queryDateSchema('End date inclusive (YYYY-MM-DD)'),
      search: querySearchSchema('Matched against the entry\'s content (its full text) and its index description.'),
      ...queryPageSchema,
    }).strict(),
  planning_actions: z.object({ from: queryDateSchema('Inclusive planning start date'), to: queryDateSchema('Inclusive planning end date'), after: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), projects: z.array(z.string()).optional() }).strict(),
  update_occurrence: z.object({ delegation: delegationSchema.nullable().optional(), template: z.string(), original: z.string(), name: z.string().min(1).optional(), scheduled: z.string().nullable().optional(), timezone: z.string().nullable().optional(), duration: z.string().nullable().optional(), calendar: calendarNameSchema.nullable().optional(), calendar_account: z.string().nullable().optional(), deadline: z.string().nullable().optional(), resolution: z.enum(['done', 'cancelled']).nullable().optional(), body: z.string().optional(), body_file: bodyFileSchema, description: z.string().optional() }).strict(),
  query_actions: z.object({
      ids: z.array(z.string()).optional().describe('Exact action IDs. Omit = no filter; [] matches nothing.'),
      projects: z.array(z.string()).optional().describe('Filter by associated project IDs. Omit = no filter; [] = actions with no project.'),
      created_from: queryDateSchema('Creation date start (YYYY-MM-DD)'),
      created_to: queryDateSchema('Creation date end (YYYY-MM-DD)'),
      scheduled_from: queryDateSchema('Scheduled date start (YYYY-MM-DD)'),
      scheduled_to: queryDateSchema('Scheduled date end (YYYY-MM-DD)'),
      deadline_from: queryDateSchema('Deadline start (YYYY-MM-DD)'),
      deadline_to: queryDateSchema('Deadline end (YYYY-MM-DD)'),
      status: z.array(z.enum(['backlog', 'scheduled', 'done', 'cancelled'])).optional().describe('Filter by lifecycle state — matches actions in ANY listed state (OR): backlog (no scheduled time), scheduled (has a scheduled time, unresolved), done, cancelled. Omit = no filter; [] matches nothing. Time-relative views compose a status with a date bound; bounds are inclusive, so "before today" passes yesterday: overdue = [scheduled,backlog] + deadline_to:<yesterday>; slipped = [scheduled] + scheduled_to:<yesterday>; upcoming = [scheduled] + scheduled_from:<today>.'),
      search: querySearchSchema('Matched against the action\'s name, description, and body.'),
      ...queryPageSchema,
    }).strict(),
  query_projects: z.object({
      ids: z.array(z.string()).optional().describe('Exact project IDs. Omit = no filter; [] matches nothing.'),
      related_to: z.array(z.string()).optional().describe('Filter by related project IDs. Omit = no filter; [] = projects with no related project.'),
      created_from: queryDateSchema('Created date start (YYYY-MM-DD)'),
      created_to: queryDateSchema('Created date end (YYYY-MM-DD)'),
      ended_from: queryDateSchema('Ended date start (YYYY-MM-DD)'),
      ended_to: queryDateSchema('Ended date end (YYYY-MM-DD)'),
      status: z.enum(['open', 'closed']).optional().describe('Lifecycle status'),
      search: querySearchSchema('Matched against the project\'s name, description, and body.'),
      ...queryPageSchema,
    }).strict(),
  query_artifacts: z.object({
      ids: z.array(z.string()).optional().describe('Exact artifact IDs. Omit = no filter; [] matches nothing.'),
      projects: z.array(z.string()).optional().describe('Project associations derived from entry tags or references in project bodies. Omit = no filter; [] = artifacts with no project.'),
      actions: z.array(z.string()).optional().describe('Action associations derived from entry tags or references in action bodies. Omit = no filter; [] = artifacts with no action.'),
      created_from: queryDateSchema('Creation date start (YYYY-MM-DD, inclusive)'),
      created_to: queryDateSchema('Creation date end (YYYY-MM-DD, inclusive)'),
      search: querySearchSchema('Matched against artifact name, index description, and Markdown body; not attachment contents.'),
      ...queryPageSchema,
    }).strict(),
  create_artifact: z.object({
      name: z.string().min(1).describe('Artifact display name; its date-prefixed slug derives the fixed ID.'),
      description: z.string().min(1).describe('One-line index summary in the user\'s voice.'),
      body: z.string().optional().describe('Markdown content. Mutually exclusive with body_file; omit both for an empty body. An empty body with one attachment uses that file as the content.'),
      body_file: bodyFileSchema,
      files: artifactFilesSchema,
    }).strict(),
  update_artifact: z.object({
      id: z.string().describe('Exact artifact ID (e.g. 2026-10-02-design-review).'),
      name: z.string().min(1).optional().describe('Update the display name without changing the ID.'),
      description: z.string().min(1).optional().describe('Replace the one-line index description.'),
      body: z.string().optional().describe('Replace the Markdown body. Mutually exclusive with body_file; omit both to preserve it. Empty text clears it.'),
      body_file: bodyFileSchema,
      files: artifactFilesSchema,
      remove_files: z.array(z.string()).optional().describe('Exact attachment filenames to remove. Omit or [] to preserve files. Each must be an existing attachment. Removal is rejected if it leaves a dangling reference in a record body or selected or referenced Markdown attachment. Cannot import and remove the same filename.'),
    }).strict(),
  capture: z.object({
      content: z.string().optional().describe('Entry content in the user\'s voice (markdown). Provide exactly one of content or content_file.'),
      content_file: contentFileSchema,
      description: z.string().describe('The entry\'s one-line index description, authored in the user\'s voice — shown in the timeline index and in query results. Keep it scannable.'),
      projects: z.array(z.union([
        z.string().describe('Existing project ID'),
        newProjectSchema,
      ])).optional().describe('Existing project IDs (prefer open projects) or new project objects'),
      actions: z.array(z.union([
        z.string().describe('Existing action ID'),
        newActionSchema,
      ])).optional().describe('Existing action IDs or new action objects'),
    }).strict(),
  update_action: z.object({
      delegation: delegationSchema.nullable().optional().describe('Replace the complete delegation; omit to preserve, null to clear.'),
      recurrence: recurrenceMutationSchema.optional(),
      id: z.string().describe('Exact action ID (e.g. 2026-05-05-deploy-db)'),
      name: z.string().refine(value => value.trim().length > 0, 'name must be nonblank').optional().describe('Change the display name while preserving the ID, filename, creation timestamp, and references.'),
      scheduled: z.string().nullable().optional().describe('Set scheduled authored wall time (minute precision, floating unless qualified by timezone; or date-only for all-day work) to schedule/reschedule; null to deschedule (back to backlog). Required to sync to calendar.'),
      deadline: z.string().nullable().optional().describe('Set hard deadline (local ISO 8601 with minute precision, or date-only when no time was specified); null to remove. Included in the calendar event\'s notes.'),
      resolution: z.enum(['done', 'cancelled']).nullable().optional().describe('"done" to complete, "cancelled" to cancel; null to reactivate.'),
      calendar: calendarNameSchema.nullable().optional().describe('Nonblank readable calendar name. Must resolve uniquely, alone or with calendar_account. null stops syncing and removes the event.'),
      calendar_account: z.string().nullable().optional().describe('Readable account name qualifying calendar; omit to preserve it, null to clear it. Omit a qualifier for uniquely named calendars.'),
      duration: z.string().nullable().optional().describe('Positive fixed ISO duration in whole minutes (e.g. PT1H, P1D = 24 elapsed hours across clock changes); null to use the default.'),
      timezone: z.string().nullable().optional().describe('Named IANA time zone for timed scheduled (e.g. Asia/Tokyo); null for floating time. All-day dates ignore it.'),
      body: z.string().optional().describe('Replace the markdown body. Mutually exclusive with body_file; omit both to keep the current body. For an action with a calendar, the body is part of the calendar event\'s notes.'),
      body_file: bodyFileSchema,
      description: z.string().optional().describe('Update the one-line index description. Omit to keep the current one. For an action with a calendar, it is part of the calendar event\'s notes.'),
    }).strict(),
  update_project: z.object({
      automations: automationsSchema.nullable().optional(),
      automationEdits: automationEditsSchema,
      id: z.string().describe('Exact project ID (e.g. 2026-05-02-migration)'),
      name: z.string().refine(value => value.trim().length > 0, 'name must be nonblank').optional().describe('Change the display name while preserving the ID, filename, creation timestamp, and references.'),
      ended: z.string().refine(isWallMinute, 'ended must be a real floating time YYYY-MM-DDTHH:mm').nullable().optional().describe('Set ended time (real Gregorian floating date and clock with minute precision, typically now) to close; null to reopen.'),
      related_projects: relatedProjectsSchema.nullable().optional().describe('Replaces the related-projects list entirely (pass the full desired set); null or [] clears it.'),
      relatedProjectEdits: relatedProjectEditsSchema,
      body: z.string().optional().describe('Replace the markdown body. Mutually exclusive with body_file; omit both to keep the current body.'),
      body_file: bodyFileSchema,
      description: z.string().optional().describe('Update the one-line index description. Omit to keep the current one.'),
    }).strict(),
  update_entry: z.object({
      id: z.string().describe('Exact entry ID (the created timestamp, e.g. 2026-05-05T14:30)'),
      content: z.string().optional().describe('Replace the entry content (markdown). Mutually exclusive with content_file; omit both to keep the current content.'),
      content_file: contentFileSchema,
      description: z.string().optional().describe('Replace the one-line index description. Omit to keep the current one.'),
      projects: z.array(z.union([
        z.string().describe('Existing project ID'),
        newProjectSchema,
      ])).nullable().optional().describe('Project links: existing IDs or new project objects. Replaces the whole set; omit to keep, [] or null to clear.'),
      actions: z.array(z.union([
        z.string().describe('Existing action ID'),
        newActionSchema,
      ])).nullable().optional().describe('Action links: existing IDs or new action objects. Replaces the whole set; omit to keep, [] or null to clear.'),
      projectEdits: z.object({
        add: z.array(z.union([z.string(), newProjectSchema])).nullable().optional(),
        remove: z.array(z.string().min(1)).nullable().optional(),
      }).strict().nullable().optional().describe('Patch project tags: add existing IDs or create-and-link objects; remove only specified IDs. Re-adding a saved tag or removing an absent tag is harmless. Exclusive with projects replacement.'),
      actionEdits: z.object({
        add: z.array(z.union([z.string(), newActionSchema])).nullable().optional(),
        remove: z.array(z.string().min(1)).nullable().optional(),
      }).strict().nullable().optional().describe('Patch action tags: add existing IDs or create-and-link objects; remove only specified IDs. Re-adding a saved tag or removing an absent tag is harmless. Exclusive with actions replacement.'),
    }).strict(),
  validate: z.object({}).strict(),
  show: z.object({
      project: z.string().min(1).optional().describe('Project ID — show its filtered timeline + summary panel (exclusive with action)'),
      action: z.string().min(1).optional().describe('Action ID — show its filtered timeline + summary panel'),
      detail: z.boolean().optional().describe('Open the project/action\'s complete record (front matter, body, hierarchy) in the document reader. detail, entry, artifact, and asset are mutually exclusive.'),
      entry: z.string().min(1).optional().describe('Entry ID (created timestamp) — scroll the timeline to it, alone or within the project/action filter. Exclusive with detail, artifact, and asset.'),
      artifact: z.string().min(1).optional().describe('Artifact ID — open its latest content in the reader. An empty body with one attachment displays that file. Composes with project/action; exclusive with detail, entry, and asset.'),
      filename: z.string().min(1).optional().describe('Exact supporting filename — open an attachment of the selected artifact; requires artifact.'),
      asset: z.string().min(1).optional().describe('Root-relative asset path (as linked from entry content) — open it in the document reader. Exclusive with detail, entry, and artifact.'),
    }).strict(),
  calendar_info: z.object({}).strict(),
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


// The executable schema is the reference for field shapes and value contracts.
// Workflow guidance belongs in MCP resources, not another field catalog.
const pageArgs = (type: string) => `
  "Maximum records on this page, from 1 to 100."
  limit: Int = 20
  "Nonnegative number of matching records to skip."
  offset: Int = 0
  "${type === 'Action' ? 'Action ordering before pagination. Scheduled and deadline orders put missing values last in either direction; see ActionOrder for clock and tie semantics.' : 'Creation order with ID as a deterministic tie-breaker.'}"
  orderBy: ${type === 'Action' ? 'ActionOrder' : 'RecordOrder'} = CREATED_DESC
`;
const relation = (type: string) => `
  "Filter the full collection before pagination."
  where: ${type}Where
  ${pageArgs(type)}
`;
const dates = (field: string) => `
  "Inclusive lower bound on the authored ${field} date; records without it do not match."
  ${field}From: Date
  "Inclusive upper bound on the authored ${field} date; records without it do not match."
  ${field}To: Date
`;
const commonWhere = (type: string) => `
  "Exact record IDs without handle prefixes.${type === 'Action' ? ' May identify projected occurrences.' : ''} Omit for any ID; [] matches nothing."
  ids: [ID!]
  ${dates('created')}
  "Case-insensitive ECMAScript regex without delimiters or flags. Matches ${type === 'Entry' ? 'content and index description' : 'name, index description, and Markdown body'}${type === 'Artifact' ? ', not attachment contents' : ''}."
  search: String
`;
const booleanWhere = (type: string) => `
  "Require every predicate; [] is true. Sibling fields are also ANDed."
  and: [${type}Where!]
  "Require at least one predicate; [] is false."
  or: [${type}Where!]
  "Negate one predicate."
  not: ${type}Where
`;
const associationIds = (field: string, what: string) => `
  "Match any of these ${what} IDs; omit for no restriction, [] for no ${what} association."
  ${field}Ids: [ID!]
`;
const bodyInput = (updating = false) => `
  "${updating ? 'Replace' : 'Initial'} Markdown body. Exclusive with bodyFile; omit both to ${updating ? 'preserve it' : 'use an empty body'}. Empty text clears it; null is not accepted."
  body: String
  "Absolute path to a readable regular UTF-8 file on this server. Its entire text supplies the body, without parsing metadata. Exclusive with body."
  bodyFile: String
`;
const contentInput = (updating = false) => `
  "${updating ? 'Replace the entry Markdown; omit both content fields to preserve it' : 'Entry Markdown in the user\'s voice; provide exactly one of content or contentFile'}. Empty text is allowed; null is not accepted."
  content: String
  "Absolute path to a readable regular UTF-8 file on this server. Its entire text supplies the entry, without parsing metadata. Exclusive with content."
  contentFile: String
`;
const descriptionInput = (required = false) => `
  "One-line index summary in the user's voice. ${required ? 'Required for discovery and scanning.' : 'Omit to preserve; null is not accepted.'}"
  description: String${required ? '!' : ''}
`;
const nameInput = (required = false) => `
  "${required ? 'Display name used to derive the fixed record ID.' : 'Display name; changing it preserves the ID and references. Omit to preserve; null is not accepted.'}"
  name: String${required ? '!' : ''}
`;
const scheduling = (mode: 'stored' | 'create' | 'update') => {
  const clear = (text: string) => mode === 'update' ? ` ${text}` : '';
  const provided = (text: string) => mode === 'create' ? ` ${text}` : '';
  return `
    "When to do the work: YYYY-MM-DD for all-day, or YYYY-MM-DDTHH:mm wall time qualified by timezone when present.${provided('Only set when the user supplied a date; omission keeps ordinary actions in backlog.')}${clear('Null deschedules an ordinary action.')}"
    scheduled: String
    "Hard deadline: YYYY-MM-DD or YYYY-MM-DDTHH:mm local wall time.${provided('Only set when the user stated a deadline.')}${clear('Null removes it.')}"
    deadline: String
    "Readable calendar name; must resolve uniquely alone or with calendarAccount. Event sync requires a calendar and either scheduled time or a template recurrence schedule.${clear('Null stops sync and removes the owned event.')}"
    calendar: String
    "Readable account name qualifying an ambiguous calendar name.${clear('Null clears the qualifier.')}"
    calendarAccount: String
    "Positive fixed ISO duration in whole minutes, such as PT1H; P1D means 24 elapsed hours. ${mode === 'update' ? 'Omit to preserve the existing or inherited duration. Null removes the stored value, restoring the PT30M default for timed Calendar events.' : 'Absent duration defaults to PT30M for timed Calendar events.'} All-day events span dates.${provided('Only set when the user supplied a duration.')}"
    duration: String
    "IANA zone qualifying a timed scheduled value, such as America/Los_Angeles; absent means floating time. All-day dates ignore it.${provided('Only set when the user specified a zone.')}${clear('Null restores floating time.')}"
    timezone: String
  `;
};
const automationsInput = (updating = false) => `
  "${updating ? 'Edit this owner’s named automations. Omit or null preserves declarations. Use set for explicit replacement; patch/upsert/remove preserve other jobs.' : 'Initial named automations for this project.'}"
  automations: ${updating ? 'AutomationEditsInput' : '[CreateAutomationInput!]'}
`;
const recordIdentity = (action = false) => `
  "Record ID without a handle prefix. Entry IDs are created timestamps; other saved IDs are date-prefixed slugs.${action ? ' Projected occurrence IDs also work with action and updateAction while present in the lookahead window.' : ''}"
  id: ID!
  "${action ? 'Saved actions have a canonical #action/id reference for Markdown. A projected occurrence has a transient reference; edit it before linking durably and use the returned saved action handle.' : 'Canonical #kind/id reference for use in Markdown.'}"
  handle: String!
  "One-line index summary; null when the index has no description."
  description: String
  "Absolute server path to the saved Markdown record. Entries sharing a week return the same containing file.${action ? ' Null for an unsaved projected occurrence; use Occurrence.projected for its semantic state.' : ''}"
  filePath: String${action ? '' : '!'}
`;
const referenceFields = `
  "Existing records directly referenced by the authored Markdown. Missing targets are omitted and diagnosed; external links, code, and self references are excluded."
  links("Nonnegative targets to skip." offset: Int = 0, "Maximum targets, 1 through 100." limit: Int = 20): LinkPage!
  "Existing indexed attachments directly referenced by the authored Markdown. Files never originate links; their bytes are not scanned."
  attachmentLinks("Nonnegative targets to skip." offset: Int = 0, "Maximum targets, 1 through 100." limit: Int = 20): AttachmentPage!
  "Saved records directly referencing this exact record. Projected actions are excluded as sources. Attachment references appear only on Attachment.backlinks."
  backlinks("Nonnegative sources to skip." offset: Int = 0, "Maximum sources, 1 through 100." limit: Int = 20): LinkPage!
`;
const mutationError = `
  "Null on success. Consolidated agent-readable failures or warnings, with confirmed saved effects and recovery guidance for partial writes. Also retained in extensions.mutations when omitted."
  error: String
`;
const recurrenceFields = `
  "Authored start: YYYY-MM-DD for all-day, or YYYY-MM-DDTHH:mm wall time for timed recurrence."
  dtstart: String!
  "RRULE containing FREQ; starts must fall on whole minutes. End with inclusive UNTIL or COUNT, never both. UNTIL uses YYYYMMDD for all-day, YYYYMMDDTHHmmss for floating time, or YYYYMMDDTHHmmssZ for zoned time."
  rrule: String!
  "IANA zone for a timed start; omit for floating time. All-day starts have no zone."
  timezone: String
`;
const attachmentsInput = `
  "Import files as attachments, copying and preserving each source. Adds or replaces only named files; omission or [] preserves existing attachments. HTML imports grant scripts read-only access to records across the selected instance when previewed; scripts can send that data externally."
  attachments: [ArtifactAttachmentInput!]
`;

export function graphQLSDL(): string {
  return `
    "Aside records and instance operations. Query root records belong to the selected instance."
    schema { query: Query mutation: Mutation }

    "A real YYYY-MM-DD calendar date. Bounds are inclusive and compare authored date portions, without converting to instants."
    scalar Date

    "Whether model discovery confirmed a choice in the current execution context."
    enum ModelAvailability {
      "Confirmed by the current catalog."
      AVAILABLE
      "Retained from a previous successful catalog after discovery failed; inspect reason."
      UNKNOWN
    }
    "One selectable automation model, including its exact selection name."
    type ModelOption {
      "Use this exact string as run.model in an automation."
      name: String!
      "Human-readable catalog label."
      label: String!
      "True for a vendor-discovered built-in selection; false for an instance-defined named selection."
      builtin: Boolean!
      "Built-in runtime, when applicable."
      engine: String
      "Exact vendor model identifier, when applicable."
      model: String
      "Confidence in the most recent discovery."
      availability: ModelAvailability!
      "Explanation of uncertain availability, when present."
      reason: String
    }
    "Behavior when an occurrence arrives while the same automation is running."
    enum AutomationOverlap {
      "Keep only the latest overlapping occurrence for one follow-up run. The default."
      LATEST
      "Drop overlapping occurrences."
      SKIP
    }
    "Exactly one schedule form: cron (optional timezone), rrule with dtstart (optional timezone), or at alone. Omit unused fields; null and incompatible fields are rejected before writes."
    input AutomationScheduleInput {
      "Five-field cron expression, minute through weekday."
      cron: String
      "RRULE containing FREQ; requires dtstart. UNTIL uses UTC YYYYMMDDTHHmmssZ and cannot combine with COUNT."
      rrule: String
      "RRULE start wall time, YYYY-MM-DDTHH:mm[:ss]."
      dtstart: String
      "IANA zone for cron or RRULE; omission uses the machine's local zone. Not used with at."
      timezone: String
      "One-time ISO timestamp with Z or an explicit offset."
      at: String
    }
    "Exactly one execution form: script with optional args, or model with prompt. Omit unused fields; null and incompatible fields are rejected before writes."
    input AutomationRunInput {
      "Executable path or PATH command, launched without a shell in the configured execution cwd."
      script: String
      "Literal arguments for script; no shell expansion."
      args: [String!]
      "Selectable model name from this instance's execution.models catalog; requires prompt. Newly supplied choices are validated in this owner's instance."
      model: String
      "Artifact the agent reads for instructions; link its exact ID or create it inline. The launched prompt contains its handle, without copying its contents."
      prompt: ArtifactLinkInput
    }
    "Agent execution configuration; model choices and artifact creation follow automation authoring."
    input AgentRunInput {
      "Selectable model name from this instance's execution.models catalog."
      model: String!
      "Artifact with readable primary instructions; link its exact ID or create inline."
      prompt: ArtifactLinkInput!
    }
    "Prompt-only automation defined on an action, called delegation. The action supplies scheduling; timeout defaults to PT30M. Scripts are unsupported."
    input DelegationInput {
      "Agent and artifact supplying instructions."
      run: AgentRunInput!
      "Positive fixed ISO duration, up to 2147483647ms; omit for PT30M. Null is not accepted."
      timeout: String
    }
    "One complete named automation declaration. Duplicate names in an authoring list are rejected. Omit optional fields for defaults; null is not accepted. The enclosing automations input defines replacement scope."
    input CreateAutomationInput {
      "Nonblank name unique within the defining instance or project."
      name: String!
      "When to execute."
      schedule: AutomationScheduleInput!
      "What to execute."
      run: AutomationRunInput!
      "Whether to schedule runs; defaults to true."
      enabled: Boolean
      "Positive fixed ISO duration; defaults to PT30M and must not exceed 2147483647 milliseconds."
      timeout: String
      "Concurrent occurrence policy; defaults to LATEST."
      overlap: AutomationOverlap
    }

    "Patch fields on an existing named job. Omitted fields preserve saved values, including unavailable models. Null removes optional fields and restores defaults. schedule and run themselves cannot be null; their supplied nested fields are merged, and the resulting job must have a valid schedule and execution form."
    input UpdateAutomationInput {
      "Exact existing nonblank job name; use upsert to create a new job."
      name: String!
      "Merge only supplied schedule fields; omit to preserve. Cannot be null."
      schedule: AutomationSchedulePatchInput
      "Merge only supplied execution fields; omit to preserve. Cannot be null."
      run: AutomationRunPatchInput
      "Set scheduling eligibility; null removes the override and restores true."
      enabled: Boolean
      "Set a positive fixed ISO duration; null restores PT30M."
      timeout: String
      "Set concurrent occurrence policy; null restores LATEST."
      overlap: AutomationOverlap
    }
    "Merge supplied fields into the existing schedule. Omission preserves; null removes a field. To switch forms, explicitly null the old form's incompatible fields and supply the new ones. The merged result must contain exactly one of cron, rrule with dtstart, or at."
    input AutomationSchedulePatchInput {
      "Five-field cron expression; null removes it when changing schedule form."
      cron: String
      "RRULE containing FREQ; null removes it when changing schedule form."
      rrule: String
      "RRULE start wall time, YYYY-MM-DDTHH:mm[:ss]; null removes it when changing schedule form."
      dtstart: String
      "IANA zone; null removes the override and restores the machine's local zone for cron/RRULE."
      timezone: String
      "One-time ISO timestamp with Z or an explicit offset; null removes it when changing schedule form."
      at: String
    }
    "Merge supplied fields into the existing execution definition. Omission preserves; null removes a field. To switch script/model execution, explicitly null incompatible fields and provide the new required fields. Only explicitly supplied model choices must be selectable; an omitted saved model is preserved."
    input AutomationRunPatchInput {
      "Executable path or PATH command; null removes it when switching to model execution."
      script: String
      "Literal script arguments; null removes them."
      args: [String!]
      "New selectable model name; omit to preserve an unavailable saved choice; null removes it when switching to scripts."
      model: String
      "Link or create the artifact supplying instructions; null removes it when switching to script execution."
      prompt: ArtifactLinkInput
    }

    "Changes to individual named automation declarations. Patches merge fields on existing jobs; upserts replace complete definitions; remove deletes jobs. Names must be nonblank and unique within each list, and occur in only one operation. Edited declarations are validated; unrelated jobs remain intact."
    input AutomationEditsInput {
      "Replace all of this owner’s declarations; [] clears. Exclusive with patch, upsert, and remove. Null is not accepted."
      set: [CreateAutomationInput!]
      "Update only supplied fields on these existing jobs. Omit, null, or [] patches nothing."
      patch: [UpdateAutomationInput!]
      "Create or replace only these jobs using their complete definitions. Omit, null, or [] leaves other jobs unchanged."
      upsert: [CreateAutomationInput!]
      "Remove only these exact job names; absent names are harmless. Omit, null, or [] removes nothing."
      remove: [String!]
    }

    "Observed process outcome, without asserting whether the user's requested task was completed."
    enum AutomationRunStatus {
      "This daemon is observing an active execution."
      RUNNING
      "Process exited successfully."
      SUCCEEDED
      "Execution failed; inspect error and logs."
      FAILED
      "Execution exceeded its configured timeout."
      TIMED_OUT
      "Execution was cancelled during shutdown."
      CANCELLED
      "An earlier daemon left this run unfinished; its outcome is unknown."
      UNOBSERVED
    }
    "Output stream retained for an automation run."
    enum AutomationLogStream {
      "Standard output."
      STDOUT
      "Standard error."
      STDERR
    }
    "Execution context for this instance. Reading never executes work."
    type Execution {
      "Expected absolute .aside execution configuration path, including when the file is absent."
      filePath: String!
      "Resolved execution working directory; null when configuration is invalid."
      cwd: String
      "Selectable model names in this execution context. Vendor discovery runs only when this field is selected."
      models("Recheck discovery instead of reusing the catalog." refresh: Boolean = false): [ModelOption!]!
    }
    "Exact named declaration filter."
    input AutomationWhere { "Exact declared name." name: String }
    "Retained execution filters, applied before pagination."
    input AutomationRunWhere {
      "Exact retained run ID."
      id: ID
      "Exact automation name."
      name: String
      "Match these observed process outcomes; omit for any, [] for none."
      status: [AutomationRunStatus!]
    }
    "Persisted schedule fields. Exactly one cron, rrule with dtstart, or at form."
    type AutomationSchedule {
      "Five-field cron expression."
      cron: String
      "Stored recurrence rule."
      rrule: String
      "Stored start wall time."
      dtstart: String
      "Stored IANA zone override."
      timezone: String
      "One-time ISO instant."
      at: String
    }
    "Persisted execution fields. Either script with optional args, or model with prompt."
    type AutomationRunDefinition {
      "Executable path or PATH command."
      script: String
      "Literal script arguments."
      args: [String!]
      "Stored model selection name; may no longer be selectable."
      model: String
      "Existing artifact the agent reads for instructions. Null with diagnostics for a missing target. Stored prompts are direct primary artifact handles; contents are not copied into the launched prompt."
      prompt: Artifact
    }
    "One named declaration on its enclosing instance, project, or action. An action delegation has the name delegation. Invalid saved declarations have null configuration fields and source diagnostics. Observations are null when unavailable."
    type Automation {
      "Exact name, unique within this owner."
      name: String!
      "Persisted schedule; null if invalid or derived from an owning action."
      schedule: AutomationSchedule
      "Persisted execution definition; null if invalid."
      run: AutomationRunDefinition
      "Defaults to true."
      enabled: Boolean
      "Defaults to PT30M."
      timeout: String
      "Defaults to LATEST."
      overlap: AutomationOverlap
      "Next observed deadline as a UTC timestamp; null when none is armed or inspection is unavailable."
      next: String
      "Whether an execution is active; null when observation is unavailable."
      running: Boolean
      "Retained runs for this owner and job, newest first."
      log("Retained execution filters." where: AutomationRunWhere, "Nonnegative runs to skip." offset: Int = 0, "Maximum runs, 1 through 100." limit: Int = 20): AutomationRunPage!
    }
    "Named declarations in name order."
    type AutomationPage {
      "Declarations on this page."
      nodes: [Automation!]!
      "Number of matching declarations skipped."
      offset: Int!
      "Number of declarations on this page."
      count: Int!
      "Matching declarations before pagination."
      totalCount: Int!
    }
    "A page of retained automation executions."
    type AutomationRunPage {
      "Runs on this page."
      nodes: [AutomationRun!]!
      "Number of retained runs before pagination; excludes already pruned history."
      totalCount: Int!
      "Number of matching runs skipped."
      offset: Int!
      "Number of runs on this page."
      count: Int!
    }
    "Retained execution details. Model choices and definitions can differ from the current declaration."
    type AutomationRun {
      "Exact retained run ID."
      id: ID!
      "Job name at launch."
      name: String!
      "Existing current declaration with this owner/name, or null after removal."
      automation: Automation
      "Current saved action or projected occurrence owning this execution; null for instance/project jobs or if no longer resolvable."
      action: Action
      "Absolute path to retained run.json metadata."
      filePath: String!
      "Observed process outcome. UNOBSERVED means a previous daemon did not record a final outcome."
      status: AutomationRunStatus!
      "Scheduled occurrence, or forced dispatch time, as a UTC timestamp."
      occurrence: String!
      "Observed dispatch start as a UTC timestamp."
      started: String!
      "Observed completion as a UTC timestamp, when recorded."
      finished: String
      "Dispatch lateness in milliseconds."
      latenessMs: Float!
      "Failure details, when present."
      error: String
      "Why a successful action automation could not mark its action done; null when completion succeeded or does not apply."
      completionError: String
      "Resolved execution working directory at launch."
      cwd: String
      "Actual launched wrapper for an agent job: execution context, owning instance, optional Project/Action handle, automation name for instance/project jobs, and a pointer to the user's instruction artifact. Does not include artifact contents."
      prompt: String
      "Model selection name at launch; may no longer be selectable."
      model: String
      "Executable used at launch, when recorded."
      command: String
      "Arguments passed to the executable."
      args: [String!]
      "Observed process ID at launch, when recorded."
      pid: Int
      "Observed exit code, when recorded."
      exitCode: Int
      "Observed termination signal, when recorded."
      signal: String
      "Absolute server path for retained standard output; use output for MCP access. May not exist when launch failed before logging."
      stdoutLog: String!
      "Absolute server path for retained standard error; use output for MCP access. May not exist when launch failed before logging."
      stderrLog: String!
      "Read retained output in bounded byte ranges. Missing streams are empty; a pruned run returns null."
      output("Retained output stream." stream: AutomationLogStream!, "Nonnegative byte offset." offset: Int = 0, "Requested bytes, 1 through 65536; up to three extra complete a UTF-8 character." limit: Int = 16384): AutomationLogPage

    }
    "A bounded UTF-8 view of one retained output stream. Offsets count bytes, not characters. A page may read up to three extra bytes to finish a code point. Use nextOffset to continue; active logs may grow between reads."
    type AutomationLogPage {
      "Decoded output from this byte range."
      text: String!
      "Byte offset at which this page started."
      offset: Int!
      "Byte offset for the next page."
      nextOffset: Int!
      "Observed stream size in bytes."
      totalBytes: Int!
    }

    "Effective instance settings, with application defaults for absent values."
    type InstanceSettings {
      "Future projection window in days; defaults to seven."
      recurrenceLookaheadDays: Int!
      "Prefix for scheduled Calendar event titles; defaults to ▢ followed by a space. Set with UpdateInstanceInput.settings.scheduledEventTitlePrefix."
      scheduledEventTitlePrefix: String!
      "Prefix for completed Calendar event titles; defaults to ✓ followed by a space. Set with UpdateInstanceInput.settings.doneEventTitlePrefix."
      doneEventTitlePrefix: String!
    }
    "Derived task lifecycle. Completed or cancelled state takes precedence over scheduled time. Recurrence templates have null status."
    enum ActionStatus {
      "Unresolved and unscheduled ordinary action or saved occurrence."
      BACKLOG
      "Unresolved with a scheduled value."
      SCHEDULED
      "Completed."
      DONE
      "Cancelled."
      CANCELLED
    }
    "Derived from whether the project has an ended timestamp."
    enum ProjectStatus {
      "No ended timestamp."
      OPEN
      "Has an ended timestamp."
      CLOSED
    }
    "Ordering by stored creation time, with ID as tie-breaker."
    enum RecordOrder {
      "Newest first."
      CREATED_DESC
      "Oldest first."
      CREATED_ASC
    }
    "Ordering of saved actions and projected occurrences before pagination. Scheduled clocks resolve in their action timezone, or the server's local zone when floating; all-day dates use local midnight. Deadlines always use the server's local zone, independent of action timezone. Repeated named-zone times use the first instant. Missing or unresolvable values are last in either direction. Scheduled/deadline ties use created ascending then ID ascending."
    enum ActionOrder {
      "Newest creation first, with ID descending for ties."
      CREATED_DESC
      "Oldest creation first, with ID ascending for ties."
      CREATED_ASC
      "Earliest resolved scheduled time first; missing schedules last."
      SCHEDULED_ASC
      "Latest resolved scheduled time first; missing schedules last."
      SCHEDULED_DESC
      "Earliest local deadline first; missing deadlines last."
      DEADLINE_ASC
      "Latest local deadline first; missing deadlines last."
      DEADLINE_DESC
    }
    "One stored segment of a template's ordered, nonoverlapping schedule history."
    type RecurrenceSchedule { ${recurrenceFields} }
    "One recurrence schedule whose start matches its RRULE pattern. Initial lists are ordered, nonoverlapping, and cannot mix all-day and timed schedules. Append starts at or after now and closes an overlapping final schedule."
    input RecurrenceScheduleInput { ${recurrenceFields} }
    "Immutable recurrence identity and whether this occurrence has been saved."
    type Occurrence {
      "Existing recurrence template action; null with a consistency diagnostic when the saved target is missing or is not a valid template. Use template.id with UpdateOccurrenceInput.template or OccurrenceWhere.template."
      template: Action
      "Original date for all-day, wall minute for floating time, or exact UTC instant for zoned recurrence. Copy without recomputing."
      original: String!
      "Original IANA zone for zoned recurrence, otherwise null."
      timezone: String
      """
      True for an unsaved occurrence computed from its template's recurrence within the instance recurrenceLookaheadDays window. Its values and context derive from the current template; reading it never creates a saved action.
      False for a saved occurrence, regardless of its scheduled time or whether it is unresolved, completed, or cancelled. Use Action.status for lifecycle state.
      A successful edit through updateAction or updateOccurrence saves the occurrence and returns projected: false with a saved ID and handle, preserving its template/original identity. Projected IDs and handles are transient; use the returned saved handle for durable links. Copy template.id/original for identity-based edits rather than deriving them from scheduled.
      This field is computed, never stored or accepted as an edit input. Ordinary actions and templates have Action.occurrence: null.
      """
      projected: Boolean!
    }
    "Attachment retrieval metadata; bytes are not included in GraphQL responses."
    type Attachment {
      "Saved records directly referencing this exact attachment. Files never originate links; projected actions are excluded as sources."
      backlinks("Nonnegative sources to skip." offset: Int = 0, "Maximum sources, 1 through 100." limit: Int = 20): LinkPage!
      "Exact indexed filename."
      filename: String!
      "Canonical attachment handle when valid."
      handle: String
      "Validated absolute regular-file path on this server; null when retrieval fails."
      filePath: String
      "Retrieval problem and recovery guidance, when present."
      error: String
    }
    "The artifact's primary content: Markdown or a file. Supporting attachments are available separately through Artifact.attachments."
    union ArtifactContent = MarkdownContent | Attachment
    "Markdown supplying an artifact's primary content."
    type MarkdownContent {
      "Complete artifact Markdown, preserving its parsed text."
      text: String!
    }
    "Authored relationship direction relative to the enclosing project."
    enum ProjectRelationDirection {
      "This project declares a link to the other project."
      OUTGOING
      "The other project declares a link to this project."
      INCOMING
      "Both projects declare links to each other."
      BIDIRECTIONAL
    }
    "One related project, combining reciprocal declarations. Missing targets are omitted and reported by validation."
    type ProjectRelation {
      "Existing related project."
      project: Project!
      "Direction of authored declarations, useful for discovery."
      direction: ProjectRelationDirection!
      "Description authored by this project; null without an outgoing declaration."
      outgoingDescription: String
      "Description authored by the other project; null without an incoming declaration."
      incomingDescription: String
    }
    "Distinct related projects after filtering."
    type ProjectRelationPage {
      "Relationships on this page."
      nodes: [ProjectRelation!]!
      "Number of matching relationships skipped."
      offset: Int!
      "Number of relationships on this page."
      count: Int!
      "Matching relationships before pagination."
      totalCount: Int!
    }
    "A first-class record that can originate or receive content links. Select shared fields directly and use concrete fragments for entity-specific fields."
    interface LinkTarget {
      "Exact record ID."
      id: ID!
      "Canonical record handle; projected actions have transient handles."
      handle: String!
      "Creation timestamp."
      created: String!
      "One-line index summary; null when unavailable."
      description: String
      "Absolute saved record path; null for unsaved action projections."
      filePath: String
      ${referenceFields}
    }
    "Referenced attachments, sorted by canonical handle. Files are targets only."
    type AttachmentPage {
      "Attachments on this page."
      nodes: [Attachment!]!
      "Number of matching attachments skipped."
      offset: Int!
      "Number of attachments returned."
      count: Int!
      "Matching attachments before pagination."
      totalCount: Int!
    }
    "Direct Markdown links or their persistent sources, sorted by canonical handle. Contextual associations are separate."
    type LinkPage {
      "Targets or sources on this page."
      nodes: [LinkTarget!]!
      "Number of matching links skipped."
      offset: Int!
      "Number of links on this page."
      count: Int!
      "Matching links before pagination."
      totalCount: Int!
    }

    "A timestamped Markdown entry providing context for linked projects and actions."
    type Entry implements LinkTarget {
      ${referenceFields}
      ${recordIdentity()}
      "Creation timestamp and exact entry ID."
      created: String!
      "Complete entry Markdown."
      content: String!
      "Projects explicitly tagged in entry metadata."
      projects(${relation('Project')}): ProjectPage!
      "Actions explicitly tagged in entry metadata."
      actions(${relation('Action')}): ActionPage!
      "Artifacts associated through this entry’s references to an artifact or its attachments."
      artifacts(${relation('Artifact')}): ArtifactPage!
    }
    "An ongoing effort with durable context, linked entries, and associated actions."
    type Project implements LinkTarget {
      ${referenceFields}
      ${recordIdentity()}
      "Stored named automation declarations. Closing the project pauses future runs."
      automations("Exact declaration name filter." where: AutomationWhere, "Nonnegative declarations to skip." offset: Int = 0, "Maximum declarations, 1 through 100." limit: Int = 20): AutomationPage!
      "Retained automation executions, including removed declarations; newest first."
      automationLog("Retained execution filters." where: AutomationRunWhere, "Nonnegative runs to skip." offset: Int = 0, "Maximum runs, 1 through 100." limit: Int = 20): AutomationRunPage!
      "Display name."
      name: String!
      "Creation wall timestamp."
      created: String!
      "Closure wall timestamp, or null for an open project."
      ended: String
      "Complete project Markdown."
      body: String!
      "OPEN without ended, otherwise CLOSED."
      status: ProjectStatus!
      "Actions associated through shared entry tags and live recurrence-template inheritance."
      actions(${relation('Action')}): ActionPage!
      "Entries tagged with or referencing this project."
      entries(${relation('Entry')}): EntryPage!
      "Artifacts associated through entry tags or project-body references."
      artifacts(${relation('Artifact')}): ArtifactPage!
      "Distinct related projects with direction and both authored descriptions."
      relatedProjects("Match these authored directions before pagination; omit for any, [] for none." direction: [ProjectRelationDirection!], ${relation('Project')}): ProjectRelationPage!
    }
    "A unit of work, a recurrence template, or an occurrence. Unedited occurrences are projected within the instance lookahead window."
    type Action implements LinkTarget {
      "Retained delegation runs, including after the declaration is cleared; templates include all occurrence runs."
      delegationLog("Filters applied before pagination." where: AutomationRunWhere, "Nonnegative matching runs to skip." offset: Int = 0, "Maximum runs, 1 through 100." limit: Int = 20): AutomationRunPage!
      "Prompt-only automation defined on this action, called delegation and inherited by unsaved projections. Invalid saved declarations return null with diagnostics."
      delegation: Automation
      ${referenceFields}
      ${recordIdentity(true)}
      "Non-null identifies an action template: an ordered schedule history, with [] meaning dormant. Null for ordinary actions and occurrences. Templates have null status, scheduled, and occurrence; use ActionWhere.recurrenceExists to find them."
      recurrence: [RecurrenceSchedule!]
      "Occurrence identity and projection state; null for ordinary actions and recurrence templates. Current timing is independent."
      occurrence: Occurrence
      "Display name and Calendar event title."
      name: String!
      "Creation wall timestamp."
      created: String!
      ${scheduling('stored')}
      "Complete action Markdown."
      body: String!
      "Derived task lifecycle. Null for action templates, including dormant recurrence: []; otherwise completion or cancellation takes precedence over scheduled time."
      status: ActionStatus
      "Projects associated through entries, including live template inheritance for occurrences."
      projects(${relation('Project')}): ProjectPage!
      "Entries tagged with or referencing this action."
      entries(${relation('Entry')}): EntryPage!
      "Artifacts associated through entry tags or action-body references. Unsaved projections inherit their template's contextual artifacts without adding persistent backlinks."
      artifacts(${relation('Artifact')}): ArtifactPage!
    }
    "Maintained content with a stable handle, optional Markdown body, and optional file attachments."
    type Artifact implements LinkTarget {
      ${referenceFields}
      ${recordIdentity()}
      "Display name."
      name: String!
      "Creation wall timestamp."
      created: String!
      "Primary content: a nonblank body returns MarkdownContent; a blank body with exactly one indexed attachment returns Attachment. Otherwise null means there is no single primary content. File bytes are not included. Author or clear Markdown with CreateArtifactInput.body or UpdateArtifactInput.body."
      content: ArtifactContent
      "Indexed attachments with validated retrieval paths or errors; no file bytes."
      attachments: [Attachment!]!
      "Projects associated through tagged entries or project-body references."
      projects(${relation('Project')}): ProjectPage!
      "Actions associated through tagged entries or action-body references."
      actions(${relation('Action')}): ActionPage!
      "Entries referencing this artifact or its attachments; contextual navigation is separate from exact backlinks."
      entries(${relation('Entry')}): EntryPage!
    }
    ${['Entry', 'Project', 'Action', 'Artifact'].map(type => `
      "One page of ${type.toLowerCase()} records.${type === 'Action' ? ' Includes projected occurrences within the instance lookahead.' : ''} Nested collections paginate independently."
      type ${type}Page {
        "Matching records on this page."
        nodes: [${type}!]!
        "Matches before pagination; check extensions.complete before treating counts as complete."
        totalCount: Int!
        "Number of matching records skipped."
        offset: Int!
        "Actual number of records returned on this page."
        count: Int!
      }
      "Predicates over the full related set, independent of its returned page. An empty predicate matches every related record."
      input ${type}RelationFilter {
        "Require at least one matching related record."
        some: ${type}Where
        "Require no matching related record; {} means no related records. Fails when record diagnostics prevent confirming absence."
        none: ${type}Where
      }
    `).join('\n')}
    "Entry filters. Siblings are ANDed; null optional filters are omitted."
    input EntryWhere {
      ${commonWhere('Entry')}
      ${associationIds('project', 'explicitly tagged project')}
      ${associationIds('action', 'explicitly tagged action')}
      "Filter through explicit project tags."
      projects: ProjectRelationFilter
      "Filter through explicit action tags."
      actions: ActionRelationFilter
      "Filter through directly referenced artifacts."
      artifacts: ArtifactRelationFilter
      ${booleanWhere('Entry')}
    }
    "Project filters. Siblings are ANDed; null optional filters are omitted."
    input ProjectWhere {
      ${commonWhere('Project')}
      ${dates('ended')}
      "Derived open or closed state."
      status: ProjectStatus
      "Match any existing outgoing linked project ID; [] means no existing outgoing links. Reverse links are excluded."
      relatedTo: [ID!]
      "Filter through associated actions."
      actions: ActionRelationFilter
      "Filter through tagged or referencing entries."
      entries: EntryRelationFilter
      "Filter through associated artifacts."
      artifacts: ArtifactRelationFilter
      "Filter through declared and reverse project links."
      relatedProjects: ProjectRelationFilter
      ${booleanWhere('Project')}
    }
    "Match recurrence occurrences; ordinary actions and templates do not match even an empty predicate. Sibling fields are ANDed."
    input OccurrenceWhere {
      "True selects projections; false selects saved occurrences. Omit for either."
      projected: Boolean
      "Exact recurrence template action ID."
      template: ID
      "Exact Action.occurrence.original value: all-day date, floating wall minute, or UTC instant. Sibling template and projected predicates are ANDed."
      original: String
    }
    "Action filters applied to saved actions, templates, and projected occurrences before pagination."
    input ActionWhere {
      ${commonWhere('Action')}
      "True selects all action templates with non-null recurrence, including dormant [] and ended schedule histories; false selects ordinary actions and saved or projected occurrences. Omit or pass null for no restriction."
      recurrenceExists: Boolean
      "Filter recurrence occurrence metadata. {} selects all occurrences."
      occurrence: OccurrenceWhere
      ${dates('scheduled')}
      ${dates('deadline')}
      "Match any listed task lifecycle state; [] matches nothing. Templates have null status and do not match this predicate, but negating it can include them. Use recurrenceExists: false for tasks only, or true to find templates."
      status: [ActionStatus!]
      ${associationIds('project', 'associated project')}
      "Filter through associated projects, including live template inheritance."
      projects: ProjectRelationFilter
      "Filter through tagged or referencing entries."
      entries: EntryRelationFilter
      "Filter through associated artifacts."
      artifacts: ArtifactRelationFilter
      ${booleanWhere('Action')}
    }
    "Artifact filters. Search covers Markdown and metadata, not attachment contents."
    input ArtifactWhere {
      ${commonWhere('Artifact')}
      ${associationIds('project', 'associated project')}
      ${associationIds('action', 'associated action')}
      "Filter through associated projects."
      projects: ProjectRelationFilter
      "Filter through associated actions."
      actions: ActionRelationFilter
      "Filter through directly referencing entries."
      entries: EntryRelationFilter
      ${booleanWhere('Artifact')}
    }

    "Read-only access. Introspection, instances, and activeInstance work without a selection; record queries use the selected instance."
    type Query {
      "Workspace candidates together with daemon-known instances. Does not require or change the active selection."
      instances: [Instance!]!
      "This MCP session's selected instance, including its identity, settings, and instructions, or null when none. Metadata-only reads do not load records, start scheduling, or change selection."
      activeInstance: Instance
      "One saved entry by its exact timestamp ID, or null if absent."
      entry("Exact ID, without #entry/." id: ID!): Entry
      "One saved project by exact ID, or null if absent."
      project("Exact ID, without #project/." id: ID!): Project
      "One saved action or exact projected occurrence, independent of the instance lookahead, or null if absent."
      action("Exact saved or projected action ID, without #action/. Projections resolve independently of query lookahead; a saved occurrence resolves by its projected identity too." id: ID!): Action
      "One saved artifact by exact ID, or null if absent."
      artifact("Exact ID, without #artifact/." id: ID!): Artifact
      "Saved entries in the active instance."
      entries(${relation('Entry')}): EntryPage!
      "Saved projects in the active instance."
      projects(${relation('Project')}): ProjectPage!
      "Actions, including templates, saved occurrences, and unsaved occurrences within the instance recurrenceLookaheadDays window. Reading never saves projections. Filters and counts include eligible projections."
      actions(${relation('Action')}): ActionPage!
      "Saved artifacts in the active instance."
      artifacts(${relation('Artifact')}): ArtifactPage!
    }
    "One Aside data directory. Identity and workspace membership do not imply active selection."
    type Instance {
      "Persistent instance ID; paths disambiguate duplicated IDs."
      id: ID!
      "Display name."
      name: String
      "One-line instance description."
      description: String
      "Canonical absolute data-directory path on this server."
      path: String!
      "Whether this is the current MCP session's selection."
      active: Boolean!
      "Effective instance settings, including application defaults."
      settings: InstanceSettings!
      "Named automation declarations authored on this instance."
      automations("Exact declaration name filter." where: AutomationWhere, "Nonnegative declarations to skip." offset: Int = 0, "Maximum declarations, 1 through 100." limit: Int = 20): AutomationPage!
      "Retained automation executions, including removed declarations; newest first."
      automationLog("Retained execution filters." where: AutomationRunWhere, "Nonnegative runs to skip." offset: Int = 0, "Maximum runs, 1 through 100." limit: Int = 20): AutomationRunPage!
      "Execution configuration and selectable models for this instance."
      execution: Execution!
      "Per-instance instructions authored by the user. Read when entering the instance. Set at creation or replace with UpdateInstanceInput.body."
      body: String!
      "Included by startup discovery, .aside configuration, or --dir; selection does not change membership."
      workspace: Boolean!
      "Run file format, consistency, and relationship checks without changing selection. Results are reused within the request."
      validation: InstanceValidation!
    }
    "Result of validating one instance's files."
    type InstanceValidation {
      "Whether all checks passed."
      passed: Boolean!
      "False when a blocking manifest check prevented data checks."
      dataChecksRun: Boolean!
      "Individual checks and findings."
      checks: [ValidationCheck!]!
    }
    "One validation check."
    type ValidationCheck {
      "Check name."
      name: String!
      "Whether this check passed."
      passed: Boolean!
      "Findings or recovery details."
      details: [String!]!
    }

    "Result of opening the webapp in the default browser."
    enum ShowOutcome {
      "Opened the authorization handoff in the default browser."
      OPENED
      "The default browser could not be opened. Use showUrl to open in another local browser."
      UNAVAILABLE
    }
    "Target shared by show and showUrl: an optional timeline filter plus at most one entry, asset, artifact, or detail view. Empty input selects the active instance timeline. Both automatically authorize the chosen browser and redirect to this target."
    input ShowInput {
      "Project timeline filter; exclusive with action."
      project: ID
      "Action timeline filter; exclusive with project."
      action: ID
      "Scroll to this entry; exclusive with asset, artifact, and detail."
      entry: ID
      "Open an instance-root-relative asset path, as linked in entry content; exclusive with entry, artifact, and detail."
      asset: String
      "Open this artifact's current content; exclusive with entry, asset, and detail."
      artifact: ID
      "Open the complete project or action record; requires that filter, and excludes entry, asset, and artifact."
      detail: Boolean
      "Exact supporting attachment filename; requires artifact."
      filename: String
    }
    "Default-browser opening status and the requested view's bookmark URL. For a URL that authorizes another browser, call Mutation.showUrl."
    type ShowPayload {
      "Clean bookmark URL for the requested view. A fresh browser needs the authorization handoff returned by Mutation.showUrl."
      url: String!
      "Observed browser result."
      outcome: ShowOutcome!
      ${mutationError}
    }
    "Calendar authorization reported by the native helper."
    enum CalendarAuthorization {
      "Permission has not been decided."
      NOT_DETERMINED
      "Access is restricted by the system."
      RESTRICTED
      "Access was denied."
      DENIED
      "Only write access is granted."
      WRITE_ONLY
      "Full Calendar access is granted."
      FULL_ACCESS
      "Unrecognized authorization state."
      UNKNOWN
      "Native Calendar access is unavailable."
      UNAVAILABLE
      "Authorization could not be determined; inspect diagnostics."
      ERROR
    }
    "Observed sync state of an action's owned Calendar event."
    enum CalendarSyncState {
      "Awaiting synchronization."
      PENDING
      "Synchronized successfully."
      SYNCED
      "Owned event removed."
      REMOVED
      "Synchronization is disabled."
      DISABLED
      "Synchronization failed; inspect the diagnostic."
      FAILED
    }
    "A visible Calendar destination. Use readable name and account to select it."
    type Calendar {
      "Readable calendar name."
      name: String!
      "Readable owning account name."
      account: String!
      "Whether events can be written here."
      writable: Boolean!
      "Native calendar type."
      type: String!
      "Display color, when available."
      color: String
    }
    "Calendar problem with recovery guidance and optional native-helper diagnostics."
    type CalendarDiagnostic {
      "Diagnostic category."
      category: String!
      "What prevented the operation."
      reason: String!
      "Suggested recovery step."
      recovery: String!
      "Native-helper executable path."
      helperPath: String
      "Relevant helper log path."
      logPath: String
      "Captured helper error output."
      stderr: String
      "Helper command that failed."
      command: String
      "Process exit code, when available."
      exitCode: Int
      "Process termination signal, when available."
      signal: String
      "Authorization observed with this diagnostic."
      auth: CalendarAuthorization
    }
    "Current Calendar synchronization state for one action."
    type CalendarActionState {
      "Saved action ID."
      id: ID!
      "Observed sync state."
      status: CalendarSyncState!
      "State explanation, when present."
      reason: String
      "Owned native event identifier, when known."
      eventId: String
      "Whether sync marked this state for retry."
      retry: Boolean
      "Problem and recovery guidance."
      diagnostic: CalendarDiagnostic
    }
    "Outstanding Calendar failure for an action."
    type CalendarFailure {
      "Affected action ID."
      id: ID!
      "Failure and recovery guidance."
      diagnostic: CalendarDiagnostic!
    }
    "Calendar consistency issue affecting an action."
    type CalendarIssue {
      "Affected action ID."
      id: ID!
      "Issue explanation."
      reason: String!
    }
    "Calendar change observed since the instance loaded."
    type CalendarChange {
      "Affected action ID."
      id: ID!
      "Observed change summary."
      summary: String!
    }
    "Machine Calendar authorization and destinations, plus sync state when an instance is active. Does not read or write events."
    type CalendarInfoPayload {
      "Current Calendar authorization."
      authorization: CalendarAuthorization!
      "Resolved native-helper path, when available."
      helperPath: String
      "Null when calendars cannot be listed; [] means access succeeded with no calendars."
      calendars: [Calendar!]
      "Authorization or helper diagnostics."
      diagnostics: [CalendarDiagnostic!]!
      "Active instance action sync states."
      syncStates: [CalendarActionState!]!
      "Outstanding sync failures."
      failures: [CalendarFailure!]!
      "Outstanding consistency issues."
      issues: [CalendarIssue!]!
      "Changes observed since the active instance loaded."
      changes: [CalendarChange!]!
      ${mutationError}
    }

    "Create a new Aside data directory and select it for this session."
    input CreateInstanceInput {
      "Empty or nonexistent directory. Prefer an absolute path; relative paths use the MCP session working directory. If no location was given, use a directory named aside."
      path: String!
      "Nonblank instance display name."
      name: String!
      ${descriptionInput(true)}
      "Per-instance instructions; include only instructions the user actually stated."
      body: String
      "Create the Meet Aside tutorial project and starter records."
      tutorial: Boolean = false
    }
    "Successful selection of an existing instance."
    type SelectInstancePayload {
      ${mutationError}
      "Selected instance."
      instance: Instance!
    }
    "Successful instance creation and activation. Partial failures return available saved objects and error details; saved files remain authoritative."
    type CreateInstancePayload {
      ${mutationError}
      "Created instance."
      instance: Instance!
      "Created tutorial project ID when requested."
      tutorialProjectId: ID
    }
    "Declare an open-ended project relationship. For hierarchy, the higher-level project declares the link to the lower-level project."
    input RelatedProjectInput {
      "Exact saved project ID, without #project/."
      project: ID!
      "Meaning of the relationship."
      description: String!
    }
    "Create a project in entry context through capture or updateEntry. Omit unused optional fields; null is not accepted."
    input CreateProjectInput {
      ${automationsInput()}
      ${nameInput(true)}
      ${descriptionInput(true)}
      ${bodyInput()}
      "Initial outgoing project links with their relationship descriptions."
      relatedProjects: [RelatedProjectInput!]
    }
    "Create an action in entry context through capture or updateEntry. Omit optional scheduling fields unless supplied by the user; null is not accepted."
    input CreateActionInput {
      "Agent delegation; omit for no delegation. Templates supply it to projected occurrences. Null is not accepted."
      delegation: DelegationInput
      "Initial ordered nonoverlapping schedule history creates an action template with null status. [] creates a dormant template; omit for an ordinary action. Templates cannot also be scheduled. Omit unused optional fields; do not pass null."
      recurrence: [RecurrenceScheduleInput!]
      ${nameInput(true)}
      ${descriptionInput(true)}
      ${bodyInput()}
      ${scheduling('create')}
    }
    "Exactly one non-null field: link an existing project or create one with entry context."
    input ProjectLinkInput @oneOf {
      "Exact saved project ID, without #project/."
      existingId: ID
      "Create and link a new project."
      create: CreateProjectInput
    }
    "Exactly one non-null field: link an existing action or create one with entry context."
    input ActionLinkInput @oneOf {
      "Exact saved action ID, without #action/."
      existingId: ID
      "Create and link a new action."
      create: CreateActionInput
    }
    "Patch entry project tags. Omitted, null, or empty lists preserve tags. Duplicate IDs or an ID in both lists are rejected; re-adding a saved tag or removing an absent tag is harmless. Existing tag order is retained and new tags are appended."
    input ProjectTagEditsInput {
      "Replace all project tags, linking or creating each item; [] clears. Exclusive with add/remove. Null is not accepted."
      set: [ProjectLinkInput!]
      "Link saved projects or create and link new ones in this entry's context."
      add: [ProjectLinkInput!]
      "Remove only these exact project IDs. Missing targets can also be untagged."
      remove: [ID!]
    }
    "Patch entry action tags with the same preservation and conflict rules as ProjectTagEditsInput."
    input ActionTagEditsInput {
      "Replace all action tags, linking or creating each item; [] clears. Exclusive with add/remove. Null is not accepted."
      set: [ActionLinkInput!]
      "Link saved actions or create and link new ones in this entry's context."
      add: [ActionLinkInput!]
      "Remove only these exact action IDs. Missing targets can also be untagged."
      remove: [ID!]
    }
    "Patch outgoing project relationships by project ID, preserving other links. Omitted, null, or empty lists preserve links. Duplicate IDs or an ID in both lists are rejected."
    input RelatedProjectEditsInput {
      "Replace all outgoing relationships; [] clears. Exclusive with upsert/remove. Null is not accepted."
      set: [RelatedProjectInput!]
      "Add a relationship or set the supplied project's relationship description; targets must exist."
      upsert: [RelatedProjectInput!]
      "Remove only these exact project IDs; removing an absent link is harmless."
      remove: [ID!]
    }
    "Capture one entry and link or create its projects and actions. Provide exactly one content source."
    input CaptureInput {
      ${contentInput()}
      ${descriptionInput(true)}
      "Project tags for this entry; each item links an existing record or creates one."
      projects: [ProjectLinkInput!]
      "Action tags for this entry; each item links an existing record or creates one."
      actions: [ActionLinkInput!]
    }
    "Edit an existing entry. Omitted fields preserve values. Collection edit objects support explicit set replacement or incremental changes."
    input UpdateEntryInput {
      ${contentInput(true)}
      ${descriptionInput()}
      "Edit project tags; omit or null preserves them."
      projects: ProjectTagEditsInput
      "Edit action tags; omit or null preserves them."
      actions: ActionTagEditsInput
    }
    "Edit a project without changing its identity. Omit fields to preserve; only explicitly documented fields accept null clearing."
    input UpdateProjectInput {
      ${automationsInput(true)}
      ${nameInput()}
      "YYYY-MM-DDTHH:mm floating wall time to close the project; null reopens it. Closing pauses future project automations."
      ended: String
      "Edit outgoing relationships, preserving unrelated links; omit or null preserves them."
      relatedProjects: RelatedProjectEditsInput
      ${bodyInput(true)}
      ${descriptionInput()}
    }
    "Edit instance settings. Omitted fields preserve values; null title prefixes restore their defaults."
    input InstanceSettingsInput {
      "Nonnegative future recurrence projection window in days. Omit to preserve; null is not accepted."
      recurrenceLookaheadDays: Int
      "Scheduled Calendar title prefix. Empty removes decoration; null restores ▢ followed by a space."
      scheduledEventTitlePrefix: String
      "Completed Calendar title prefix. Empty removes decoration; null restores ✓ followed by a space."
      doneEventTitlePrefix: String
    }
    "Update selected instance instructions, settings, and automations while preserving its identity."
    input UpdateInstanceInput {
      ${automationsInput(true)}
      "Edit effective settings; omit or null preserves them."
      settings: InstanceSettingsInput
      "Replace per-instance instructions with user-authored text. Omit to preserve; empty text clears; null is not accepted."
      body: String
    }
    "Instance update result."
    type InstancePayload {
      ${mutationError}
      "Updated selected instance, when readable."
      instance: Instance
    }
    "Exact schedule identity copied from template metadata."
    input RecurrenceScheduleSelectorInput {
      "Exact authored dtstart of the stored schedule."
      dtstart: String!
      "Exact stored IANA zone; omit for floating or all-day schedules."
      timezone: String
    }
    "End a selected schedule exclusively at an instant. Extending into the past requires every added occurrence to already have a saved action."
    input RecurrenceEndInput {
      "Exact stored schedule identity."
      schedule: RecurrenceScheduleSelectorInput!
      "ISO timestamp with Z or an explicit offset, strictly after the start. Omit to use the server clock; the server derives inclusive UNTIL."
      at: String
    }
    "Exactly one non-null schedule command, validated before updating the action. Saved occurrences and their provenance remain unchanged. Whole-list replacement is unsupported."
    input RecurrenceMutationInput @oneOf {
      "Append a schedule starting at or after now and after the final stored start; automatically closes an overlapping final rule."
      append: RecurrenceScheduleInput
      "Set the selected schedule's exclusive end."
      setEnd: RecurrenceEndInput
      "Remove the exact schedule. Removing the last one leaves a dormant [] template."
      remove: RecurrenceScheduleSelectorInput
    }
    "Edit an action, saving a projected occurrence on its first edit. Omit fields to preserve; documented scheduling fields accept null clearing, and status: null applies only to templates. Templates stay unscheduled with null status."
    input UpdateActionInput {
      "Replace the complete delegation; omit to preserve, null to clear. Unsaved projections inherit their template; saved occurrences retain their own declaration."
      delegation: DelegationInput
      "Change a template's schedule history through exactly one command. append can also convert an ordinary action into a template while preserving its ID and context; supply status: null with append to clear its task lifecycle when needed. Occurrences cannot become templates. Removing the final schedule leaves recurrence: [] and null status."
      recurrence: RecurrenceMutationInput
      ${nameInput()}
      ${scheduling('update')}
      "DONE completes; CANCELLED cancels. BACKLOG reactivates and clears scheduled; SCHEDULED reactivates and requires an existing or supplied scheduled time. Null applies only to templates. Omit to preserve completion/cancellation; scheduled determines unresolved status."
      status: ActionStatus
      ${bodyInput(true)}
      ${descriptionInput()}
    }
    "Edit the exact template/original occurrence, materializing it if needed. At least one edit is required. Reuses an already saved occurrence; identity never changes when timing changes."
    input UpdateOccurrenceInput {
      "Replace the complete delegation; omit to preserve, null to clear on this saved occurrence."
      delegation: DelegationInput
      "Exact saved recurrence template Action.id, copied from Action.occurrence.template.id."
      template: ID!
      "Copy Action.occurrence.original: date, floating wall minute, or exact UTC instant. Do not derive from current scheduled time."
      original: String!
      ${nameInput()}
      ${scheduling('update')}
      "DONE completes; CANCELLED cancels. BACKLOG reactivates and clears scheduled; SCHEDULED reactivates and requires an existing or supplied scheduled time. Null is not accepted for occurrences. Omit to preserve completion/cancellation; scheduled determines unresolved status."
      status: ActionStatus
      ${bodyInput(true)}
      ${descriptionInput()}
    }
    "Copy a local file into artifact attachments; the original source is preserved. HTML imports grant scripts read-only access to records across the selected instance when previewed; scripts can send that data externally. Use external iframe embeds for untrusted pages."
    input ArtifactAttachmentInput {
      "Absolute path to a readable regular file on this server; any format is supported."
      source: String!
      "Single destination filename; defaults to the source basename."
      filename: String
    }
    "Link an existing prompt artifact by exact ID or create one inline. Exactly one non-null member is required. Model jobs require nonblank readable primary content when authoring. At launch the agent receives the artifact handle and reads its contents through Aside."
    input ArtifactLinkInput @oneOf {
      "Exact existing Artifact.id, without #artifact/ or a filename."
      existingId: ID
      "Create maintained prompt content in this operation; only its artifact reference is stored on the automation."
      create: CreateArtifactInput
    }
    "Create maintained content. An empty body with exactly one attachment uses that file as its content."
    input CreateArtifactInput {
      ${nameInput(true)}
      ${descriptionInput(true)}
      ${bodyInput()}
      ${attachmentsInput}
    }
    "Edit maintained content without changing its ID. Omit fields to preserve; null is not accepted."
    input UpdateArtifactInput {
      ${nameInput()}
      ${descriptionInput()}
      ${bodyInput(true)}
      ${attachmentsInput}
      "Remove exact existing attachment filenames; omission or [] preserves files. Rejects dangling references and importing/removing the same filename."
      removeAttachments: [String!]
    }
    ${['Capture', 'Entry'].map(type => `
      "Entry ${type === 'Capture' ? 'capture' : 'update'} result. Project/action lists include newly created records only; navigate entry for all linked records."
      type ${type}Payload {
        ${mutationError}
        "Saved entry, when readable."
        entry: Entry
        "Projects created by this operation, excluding links to existing projects."
        createdProjects: [Project!]!
        "Actions created by this operation, excluding links to existing actions."
        createdActions: [Action!]!
      }
    `).join('\n')}
    ${['Project', 'Action', 'Artifact'].map(type => `
      "${type} write result."
      type ${type}Payload {
        ${mutationError}
        "Saved ${type.toLowerCase()}, when readable."
        ${type.toLowerCase()}: ${type}
      }
    `).join('\n')}

    "Operations with effects. Top-level fields execute serially, without a transaction: earlier writes survive later failures. Inspect extensions.mutations and never blindly retry after an uncertain transport result."
    type Mutation {
      "Dispatch an action delegation immediately, bypassing its schedule. Leaves a projected occurrence unsaved until its first edit. Templates require an occurrence ID. Concurrent launches for one action are rejected. Successful exits mark the action done even if its fields or lifecycle changed during the run."
      runDelegation("Exact saved or projected action ID." id: ID!): AutomationRun
      "Open the requested view in the system default browser. Each call creates and opens a fresh private HTML handoff that automatically installs valid browser authorization and redirects to the target, including after expiry. Use showUrl instead when the agent will open another local browser. Browser-launch failure returns UNAVAILABLE."
      show("Timeline filter and optional content view; defaults to the timeline." input: ShowInput! = {}): ShowPayload
      "Get a URL to open the requested view in a local browser chosen by the agent, without opening or navigating any browser. Each call creates a fresh private temporary HTML file and returns its file:// URL. In Codex, use open_in_codex with target type browser and url set to the returned file:// URL. Open it immediately as returned: it submits a one-use code to the local daemon, automatically installs valid authorization in that browser profile, and redirects to the target, including after expiry. The file is owner-only, single-use, and expires after two minutes; request a new URL for each opening. The browser must be able to read this machine's local file and reach its daemon. No token handling or separate authentication call is needed. Use show for the default browser."
      showUrl("Same target selection as show; defaults to the active instance timeline." input: ShowInput! = {}): String
      "Report Calendar authorization, calendars, and active-instance sync state. May request macOS permission when undecided or write-only. No active instance is required; never reads or writes events."
      calendarInfo: CalendarInfoPayload
      "Select an existing instance for this MCP session; does not change the saved startup default. Failure stops later mutation fields, preventing writes to the previous selection."
      selectInstance("Existing data directory; relative paths resolve against the MCP session working directory." path: String!): SelectInstancePayload
      "Create and activate an instance. Failure stops later fields. Saved files survive registration failure: inspect error and recover with selectInstance instead of recreating."
      createInstance("New instance location, identity, and optional instructions." input: CreateInstanceInput!): CreateInstancePayload
      "Edit or materialize one recurrence occurrence by immutable identity; creates no entry and leaves the template unchanged. A new saved ID uses the creation date and resulting name, not the original occurrence date."
      updateOccurrence("Exact occurrence and desired edits." input: UpdateOccurrenceInput!): ActionPayload
      "Edit instance instructions, named automations, recurrence lookahead, or Calendar title prefixes; omitted fields are preserved."
      updateInstance("Supported settings; omitted fields are preserved." input: UpdateInstanceInput!): InstancePayload
      "Save a timestamped entry and link or create projects/actions in that context."
      capture("Entry content, summary, and optional project/action links." input: CaptureInput!): CapturePayload
      "Edit entry content, summary, or complete tag sets; can create newly linked projects/actions."
      updateEntry("Exact entry timestamp ID." id: ID!, "Desired entry changes." input: UpdateEntryInput!): EntryPayload
      "Edit project context, lifecycle, relationships, or automation declarations without changing its ID."
      updateProject("Exact saved project ID." id: ID!, "Desired project changes." input: UpdateProjectInput!): ProjectPayload
      "Edit an action or template. A projected occurrence ID saves that occurrence on its first edit and returns its saved ID. Calendar-bound changes synchronize through normal action handling."
      updateAction("Exact saved or projected action ID." id: ID!, "Desired action changes." input: UpdateActionInput!): ActionPayload
      "Create maintained Markdown or file content with a stable artifact handle."
      createArtifact("Artifact metadata, content, and optional file imports." input: CreateArtifactInput!): ArtifactPayload
      "Update an artifact's current content, metadata, or attachments while retaining its handle."
      updateArtifact("Exact saved artifact ID." id: ID!, "Desired artifact changes." input: UpdateArtifactInput!): ArtifactPayload
    }
  `;
}

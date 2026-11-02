import { automationDeclarations, validateExecutionConfig } from './automation.js';
import { assertDelegation } from './delegation.js';
import { assertRecurrence, assertOccurrence } from './recurrence.js';
import { assertAttachmentFilename } from './artifact-reference.js';
import { isInstanceId, INSTANCE_ID_RULE } from './identity.js';
import { isWallMinute } from './scheduling.js';
import { weekFileId } from './record-reference.js';
import type {
  Entry,
  EntryMeta,
  WeeklyFileMeta,
  WeeklyValue,
  Project,
  ProjectFrontMatter,
  Action,
  ActionFrontMatter,
  Artifact,
  ArtifactFrontMatter,
  IndexItem,
  Manifest,
  InstanceConfig,
  AsideConfig,
  ParseResult,
} from './types.js';
import {
  IssueLog,
  safeParseYaml,
  asRecord,
  reqString,
  optString,
  reqNumber,
  optBool,
  asStringList,
  asObjectList,
} from './coerce.js';

import { splitFrontMatter } from './markdown.js';
export { splitFrontMatter } from './markdown.js';

// An entry's preamble is a `---` line immediately followed by a ```entry fence. We
// split entries on the preamble — not on any `---` line — so entry content stays free
// to contain bare `---` horizontal rules. Blank lines between the `---` and the fence
// are tolerated so files written by older (padded) versions still parse; the fence
// itself must start at column 0, so an indented (quoted) example under a bare `---`
// rule is content, not an entry. See design/note.md. The leading blank line after
// the front matter splits off as an empty segment, which callers drop.
export const ENTRY_PREAMBLE = /^---[ \t\r]*\n(?:[ \t\r]*\n)*(?=```entry)/m;

// The metadata block of each entry, derived the same way parseWeeklyFile finds
// entries: split on ENTRY_PREAMBLE and take the fence each segment starts with.
// Only the leading fence counts — a ```entry fence quoted deeper inside content
// (say, an indented example under a bare `---` rule) is content, not an entry.
export function extractEntryBlocks(content: string): string[] {
  const blocks: string[] = [];
  for (const segment of content.split(ENTRY_PREAMBLE)) {
    const m = segment.match(/^\s*```entry\s*\n([\s\S]*?)```/);
    if (m) blocks.push(m[1]);
  }
  return blocks;
}

export function parseEntryBlock(block: string): ParseResult<EntryMeta> {
  const log = new IssueLog();
  const data = asRecord(safeParseYaml(block, log), log);
  const meta: EntryMeta = { created: reqString(data.created, 'created', log) };
  const projects = asStringList(data.projects, 'projects', log);
  const actions = asStringList(data.actions, 'actions', log);
  if (projects.length) meta.projects = projects;
  if (actions.length) meta.actions = actions;
  return { value: meta, issues: log.issues };
}

export function parseWeeklyFile(
  content: string,
  filename: string,
): ParseResult<WeeklyValue> {
  const log = new IssueLog();
  const { yaml, body } = splitFrontMatter(content);
  const data = asRecord(safeParseYaml(yaml, log), log);
  const meta: WeeklyFileMeta = {
    week: reqNumber(data.week, 'week', log),
    week_start: reqString(data.week_start, 'week_start', log),
    week_end: reqString(data.week_end, 'week_end', log),
  };

  const entries: Entry[] = [];
  const segments = body.split(ENTRY_PREAMBLE);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    // Leading fence only, the same rule as extractEntryBlocks: a segment is an
    // entry iff it begins with its metadata fence.
    const entryBlockMatch = trimmed.match(/^```entry\s*\n([\s\S]*?)```\s*\n?([\s\S]*)/);
    if (!entryBlockMatch) {
      // An opening fence with no closing ``` would otherwise vanish silently —
      // record it, honoring "the parser never throws; it records issues".
      if (trimmed.startsWith('```entry')) {
        log.error('unterminated_entry_block', `${filename}: unterminated \`\`\`entry metadata block — entry skipped`);
      }
      continue;
    }
    const entryResult = parseEntryBlock(entryBlockMatch[1]);
    log.issues.push(...entryResult.issues);
    if (entryResult.value.created) {
      entries.push({
        meta: entryResult.value,
        content: entryBlockMatch[2].trim(),
        weekFile: weekFileId(filename),
      });
    }
  }

  return { value: { meta, entries }, issues: log.issues };
}

export function parseProjectFile(content: string): ParseResult<Project> {
  const log = new IssueLog();
  const { yaml, body } = splitFrontMatter(content);
  const data = asRecord(safeParseYaml(yaml, log), log);
  const frontMatter: ProjectFrontMatter = {
    name: reqString(data.name, 'name', log),
    created: reqString(data.created, 'created', log),
  };
  const automations = automationDeclarations(data.automations, log);
  if (automations) frontMatter.automations = automations;
  const ended = optString(data.ended, 'ended', log);
  if (ended !== undefined) {
    frontMatter.ended = ended;
  }
  if (data.ended === '' || (ended !== undefined && !isWallMinute(ended))) {
    log.error('invalid_timestamp', 'ended must be a real floating time YYYY-MM-DDTHH:mm', 'ended');
  }
  if (data.related_projects != null) {
    frontMatter.related_projects = asObjectList(data.related_projects, 'related_projects', log)
      .map((r) => ({
        project: optString(r.project, 'related_projects.project', log),
        description: optString(r.description, 'related_projects.description', log) ?? '',
      }))
      .filter((r): r is { project: string; description: string } => {
        if (r.project == null || r.project === '') {
          log.warn('dropped_item', 'Dropped a related project with no project id', 'related_projects');
          return false;
        }
        return true;
      });
  }
  return { value: { frontMatter, body: body.trim() }, issues: log.issues };
}

export function parseActionFile(content: string): ParseResult<Action> {
  const log = new IssueLog();
  const { yaml, body } = splitFrontMatter(content);
  const data = asRecord(safeParseYaml(yaml, log), log);
  const frontMatter: ActionFrontMatter = {
    name: reqString(data.name, 'name', log),
    created: reqString(data.created, 'created', log),
  };
  if (data.delegation !== undefined) {
    try { frontMatter.delegation = assertDelegation(data.delegation); }
    catch (error) {
      frontMatter.delegation = data.delegation as ActionFrontMatter['delegation'];
      log.error('invalid_delegation', (error as Error).message, 'delegation');
    }
  }
  // Optional text fields copy over when present; `resolution` alone has a
  // closed set of values. The field order fixes the order of any issues.
  const copy = (keys: readonly ('scheduled' | 'deadline' | 'timezone' | 'duration' | 'calendar' | 'calendar_account')[]) => {
    for (const key of keys) {
      const value = optString(data[key], key, log);
      if (value !== undefined) frontMatter[key] = value;
    }
  };
  copy(['scheduled', 'deadline']);
  const resolution = optString(data.resolution, 'resolution', log);
  if (resolution === 'done' || resolution === 'cancelled') {
    frontMatter.resolution = resolution;
  } else if (resolution !== undefined) {
    log.warn('wrong_value', `Field "resolution" should be "done" or "cancelled" but found "${resolution}"`, 'resolution');
  }
  copy(['timezone', 'duration', 'calendar', 'calendar_account']);
  for (const key of ['recurrence', 'occurrence'] as const) if (data[key] !== undefined) {
    try {
      if (key === 'recurrence') frontMatter.recurrence = assertRecurrence(data[key]);
      else frontMatter.occurrence = assertOccurrence(data[key]);
    } catch (error) {
      // Preserve invalid declarations for diagnostics/repair; never silently
      // reinterpret a malformed template as an ordinary action.
      (frontMatter as unknown as Record<string, unknown>)[key] = data[key];
      log.error('invalid_' + key, (error as Error).message, key);
    }
  }
  return { value: { frontMatter, body: body.trim() }, issues: log.issues };
}

export function parseArtifactFile(content: string): ParseResult<Artifact> {
  const log = new IssueLog();
  const { yaml, body } = splitFrontMatter(content);
  const data = asRecord(safeParseYaml(yaml, log), log);
  const frontMatter: ArtifactFrontMatter = {
    name: reqString(data.name, 'name', log),
    created: reqString(data.created, 'created', log),
  };
  const attachments = asStringList(data.attachments, 'attachments', log).filter(filename => {
    try { assertAttachmentFilename(filename); return true; }
    catch (err) {
      log.warn('invalid_attachment_filename', err instanceof Error ? err.message : String(err), 'attachments');
      return false;
    }
  });
  if (attachments.length) frontMatter.attachments = attachments;
  return { value: { frontMatter, body: body.trim() }, issues: log.issues };
}

// Parse an instance manifest (`aside.md`). `id` is required; `version`, `name`,
// and `description` are optional. A manifest missing `id` parses best-effort with
// a missing-field issue.
export function parseManifest(content: string): ParseResult<Manifest> {
  const log = new IssueLog();
  const { yaml } = splitFrontMatter(content);
  const data = asRecord(safeParseYaml(yaml, log), log);
  const manifest: Manifest = { id: reqString(data.id, 'id', log) };
  if (manifest.id && !isInstanceId(manifest.id)) log.error('invalid_instance_id', INSTANCE_ID_RULE, 'id');
  const version = optString(data.version, 'version', log);
  if (version !== undefined) manifest.version = version;
  const name = optString(data.name, 'name', log);
  if (name !== undefined) manifest.name = name;
  const description = optString(data.description, 'description', log);
  if (description !== undefined) manifest.description = description;
  const automations = automationDeclarations(data.automations, log);
  if (automations) manifest.automations = automations;
  const config = parseInstanceConfig(data.config, log);
  if (config) manifest.config = config;
  return { value: manifest, issues: log.issues };
}

// Parse the manifest's optional `config` block. Prefixes are settings, so an
// explicit empty string is a real value (e.g. no `✓` on done events) and is kept,
// unlike data fields where empty means absent; an absent key takes the default.
function parseInstanceConfig(value: unknown, log: IssueLog): InstanceConfig | undefined {
  if (value == null) return undefined;
  const data = asRecord(value, log);
  const config: InstanceConfig = {};
  if (data.recurrenceLookaheadDays !== undefined) {
    if (typeof data.recurrenceLookaheadDays === 'number' && Number.isSafeInteger(data.recurrenceLookaheadDays) && data.recurrenceLookaheadDays >= 0) config.recurrenceLookaheadDays = data.recurrenceLookaheadDays;
    else log.error('invalid_recurrence_lookahead', 'recurrenceLookaheadDays must be a nonnegative integer.', 'config.recurrenceLookaheadDays');
  }
  for (const key of ['scheduledEventTitlePrefix', 'doneEventTitlePrefix'] as const) {
    const v = data[key];
    if (v == null) continue;
    if (typeof v === 'string') config[key] = v;
    else log.warn('wrong_type', `Field "config.${key}" should be text`, `config.${key}`);
  }
  // Flag an unrecognized key rather than silently ignoring it — a misspelled
  // `doneEventTitlePrefix` would otherwise apply nothing with no feedback.
  for (const key of Object.keys(data)) {
    if (key !== 'scheduledEventTitlePrefix' && key !== 'doneEventTitlePrefix' && key !== 'recurrenceLookaheadDays') {
      log.warn('unknown_field', `Unknown config field "${key}"`, `config.${key}`);
    }
  }
  return Object.keys(config).length ? config : undefined;
}

// Parse a `.aside` config file: pointers to data directories, an optional
// default, and an optional `discovery` toggle. Pure YAML (no front matter).
// Every field is optional, so an empty file yields an empty config with no issues.
export function parseConfig(content: string): ParseResult<AsideConfig> {
  const log = new IssueLog();
  const data = asRecord(safeParseYaml(content, log), log);
  const config: AsideConfig = {};
  if (data.execution !== undefined) {
    try { config.execution = validateExecutionConfig(data.execution); }
    catch (error) { log.error('invalid_execution_config', (error as Error).message, 'execution'); }
  }
  const pointers = asStringList(data.pointers, 'pointers', log);
  if (pointers.length) config.pointers = pointers;
  const def = optString(data.default, 'default', log);
  if (def !== undefined) config.default = def;
  const discovery = optBool(data.discovery, 'discovery', log);
  if (discovery !== undefined) config.discovery = discovery;
  const worktreeDetection = optBool(data.worktreeDetection, 'worktreeDetection', log);
  if (worktreeDetection !== undefined) config.worktreeDetection = worktreeDetection;
  // Flag unrecognized keys rather than silently ignoring them — a misspelled
  // `discovery` or `pointers` would otherwise take effect as nothing with no
  // feedback. Mirrors the manifest's config block.
  for (const key of Object.keys(data)) {
    if (key !== 'pointers' && key !== 'default' && key !== 'discovery' && key !== 'worktreeDetection' && key !== 'execution') {
      log.warn('unknown_field', `Unknown config field "${key}"`, key);
    }
  }
  return { value: config, issues: log.issues };
}

// Parse a year index (`index.yaml`) — the same format for notes, projects, and
// actions: a YAML list of {id, description} items.
export function parseIndex(content: string): ParseResult<IndexItem[]> {
  const log = new IssueLog();
  const items = asObjectList(safeParseYaml(content, log), 'index', log).map((item) => ({
    id: reqString(item.id, 'id', log),
    description: optString(item.description, 'description', log) ?? '',
  }));
  return { value: items, issues: log.issues };
}

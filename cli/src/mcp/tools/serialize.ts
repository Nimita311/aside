import { stringify } from 'yaml';
import { yamlQuote } from './yaml.js';
import { serializeExistingRecord } from './front-matter.js';
import { parseActionFile, parseProjectFile, parseArtifactFile } from '../../core/parser.js';
import type { ActionFrontMatter, ProjectFrontMatter, ArtifactFrontMatter } from '../../core/types.js';
import { applyAutomationEditsToMetadata, type AutomationEdits } from './automation-edits.js';
import { applyRelatedProjectEditsToMetadata, type RelatedProjectEdits } from './link-edits.js';

// Serialize an action to its full file content (`---` front matter + body). The
// single source of truth for an action's on-disk shape — used by both capture
// (new actions) and update. Optional fields are omitted when absent.
export function serializeAction(fm: ActionFrontMatter, body: string | undefined, file?: string, fields?: readonly string[]): string {
  let out = `name: ${yamlQuote(fm.name)}\ncreated: ${fm.created}`;
  if (fm.scheduled) out += `\nscheduled: ${yamlQuote(fm.scheduled)}`;
  if (fm.timezone) out += `\ntimezone: ${yamlQuote(fm.timezone)}`;
  if (fm.duration) out += `\nduration: ${yamlQuote(fm.duration)}`;
  if (fm.calendar) out += `\ncalendar: ${yamlQuote(fm.calendar)}`;
  if (fm.calendar_account) out += `\ncalendar_account: ${yamlQuote(fm.calendar_account)}`;
  if (fm.deadline) out += `\ndeadline: ${yamlQuote(fm.deadline)}`;
  if (fm.resolution) out += `\nresolution: ${fm.resolution}`;
  if (fm.delegation !== undefined) out += '\n' + stringify({delegation: fm.delegation}).trimEnd();
  if (fm.recurrence !== undefined) out += '\n' + stringify({ recurrence: fm.recurrence }).trimEnd();
  if (fm.occurrence !== undefined) out += '\n' + stringify({ occurrence: fm.occurrence }).trimEnd();
  const canonical = `---\n${out}\n---\n\n${body ?? ''}\n`;
  return file ? serializeExistingRecord(file, canonical, ['name', 'created', 'scheduled', 'timezone', 'duration', 'calendar', 'calendar_account', 'deadline', 'resolution', 'recurrence', 'occurrence', 'delegation'], record => parseActionFile(record).value.frontMatter, fields, undefined, body === undefined) : canonical;
}

// Serialize a project to its full file content. The single source of truth for a
// project's on-disk shape — used by both capture (new projects) and update.
export function serializeProject(fm: ProjectFrontMatter, body: string | undefined, file?: string, fields?: readonly string[], automationEdits?: AutomationEdits, relatedProjectEdits?: RelatedProjectEdits): string {
  let out = `name: ${yamlQuote(fm.name)}\ncreated: ${fm.created}`;
  if (fm.automations !== undefined) out += '\n' + stringify({ automations: fm.automations }).trimEnd();
  if (fm.ended) out += `\nended: ${yamlQuote(fm.ended)}`;
  if (fm.related_projects && fm.related_projects.length > 0) {
    out += '\nrelated_projects:';
    for (const rp of fm.related_projects) {
      out += `\n  - project: ${yamlQuote(rp.project)}\n    description: ${yamlQuote(rp.description)}`;
    }
  }
  const canonical = `---\n${out}\n---\n\n${body ?? ''}\n`;
  return file ? serializeExistingRecord(file, canonical, ['name', 'created', 'automations', 'ended', 'related_projects'], record => parseProjectFile(record).value.frontMatter, fields,
    automationEdits || relatedProjectEdits ? source => {
      if (automationEdits) source = applyAutomationEditsToMetadata(source, automationEdits, file);
      if (relatedProjectEdits) source = applyRelatedProjectEditsToMetadata(source, relatedProjectEdits, file);
      return source;
    } : undefined, body === undefined) : canonical;
}

export function serializeArtifact(fm: ArtifactFrontMatter, body: string | undefined, file?: string, fields?: readonly string[]): string {
  let out = `name: ${yamlQuote(fm.name)}\ncreated: ${fm.created}`;
  if (fm.attachments?.length) out += `\nattachments: [${fm.attachments.map(yamlQuote).join(', ')}]`;
  const canonical = `---\n${out}\n---\n\n${body ?? ''}\n`;
  return file ? serializeExistingRecord(file, canonical, ['name', 'created', 'attachments'], record => parseArtifactFile(record).value.frontMatter, fields, undefined, body === undefined) : canonical;
}

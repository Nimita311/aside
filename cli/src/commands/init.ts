import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { publishReport } from './output.js';
import { parseCommand, type CommandInput } from './options.js';
import { stringify } from 'yaml';
import { VERSION } from '../version.js';
import { createInstanceId } from '../core/identity.js';
import { formatDate, formatTimestamp, getMonday, getSunday, getWeekNumber } from '../core/date.js';
import { writeFileCrashSafe } from '../mcp/tools/index-file.js';
import { assertManagedPath } from '../core/managed-path.js';

// Tutorial templates are embedded into the build as strings (esbuild text
// loader; Vite equivalent for tests). They travel inside the artifact, so init
// never reads them from disk — there is no template path to resolve and nothing
// to break when the bundle ships at a different depth than the source tree.
// The manifest (`aside.md`) is not a template: it is built programmatically
// below so optional fields can be omitted and values YAML-escaped.
import notesIndexYaml from '../../templates/notes/index.yaml';
import notesWeekMd from '../../templates/notes/week.md';
import projectsIndexYaml from '../../templates/projects/index.yaml';
import projectsProjectMd from '../../templates/projects/project.md';
import actionsIndexYaml from '../../templates/actions/index.yaml';
import actionsCaptureMd from '../../templates/actions/capture-entry.md';
import actionsStartProjectMd from '../../templates/actions/start-project.md';
import actionsScheduleMd from '../../templates/actions/schedule-action.md';

const TEMPLATES: Record<string, string> = {
  'notes/index.yaml': notesIndexYaml,
  'notes/week.md': notesWeekMd,
  'projects/index.yaml': projectsIndexYaml,
  'projects/project.md': projectsProjectMd,
  'actions/index.yaml': actionsIndexYaml,
  'actions/capture-entry.md': actionsCaptureMd,
  'actions/start-project.md': actionsStartProjectMd,
  'actions/schedule-action.md': actionsScheduleMd,
};

function render(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

// Build the `aside.md` manifest: front matter (`id`, `version`, `name`,
// `description`) followed by an optional free-form body. `id` is the stable
// instance identifier, derived from `name` where possible. The serializer YAML-escapes values;
// surrounding whitespace is trimmed and a blank body is dropped.
function buildManifest(name: string, description: string, body?: string): string {
  const trimmedName = name.trim();
  const frontMatter: Record<string, string> = {
    id: createInstanceId(trimmedName),
    version: VERSION,
    name: trimmedName,
    description: description.trim(),
  };
  let content = `---\n${stringify(frontMatter).trimEnd()}\n---\n`;
  const trimmedBody = body?.trim();
  if (trimmedBody) content += `\n${trimmedBody}\n`;
  return content;
}

export interface InitOptions {
  // Manifest display name (required).
  name: string;
  // Manifest description (required) — one line that helps an agent select among instances.
  description: string;
  // Free-form manifest body: per-instance instructions the agent loads on entry.
  body?: string;
  // When true, also lay down the "Meet Aside" guided-tour project, its starter
  // actions, and a seeded first entry. When false (default), only the manifest
  // is written; the data scaffold is created on first capture.
  tutorial?: boolean;
}

export interface InitResult {
  created: string[];
  dataDir: string;
  // Present only when tutorial content was created. Carries the entry point
  // (the tour project ID) so callers can steer the agent into the walkthrough.
  tutorial?: { projectId: string };
}

export function init(dataDir: string, options: InitOptions, onCreated?: (relativePath: string) => void): InitResult {
  dataDir = resolve(dataDir);
  if (existsSync(dataDir)) {
    const contents = readdirSync(dataDir);
    if (contents.length > 0) {
      throw new Error(`Directory ${dataDir} already exists and is not empty.\nChoose a different path.`);
    }
  }

  mkdirSync(dataDir, { recursive: true });

  const created: string[] = [];

  // The manifest is the one file every instance has — it is what marks the
  // directory as an aside instance.
  writeFileCrashSafe(join(dataDir, 'aside.md'), buildManifest(options.name, options.description, options.body), dataDir);
  created.push('aside.md');
  onCreated?.('aside.md');

  if (!options.tutorial) {
    return { created, dataDir };
  }

  const now = new Date();
  const today = formatDate(now);
  const monday = getMonday(now);
  const sunday = getSunday(now);
  // Project/action files are keyed by today's date; the weekly file and notes
  // index live under the Monday's year — the same rule capture uses — so a New
  // Year week is not split across two year directories.
  const year = String(now.getFullYear());
  const notesYear = String(monday.getFullYear());

  // Display names and slugs never change with the calendar; only the date prefix
  // and the created timestamp do. So the slugs are hard-coded here (and the
  // matching display names live in the templates), while the date stays dynamic
  // — the ID is `${today}-${slug}` to keep date codes in step with `created`.
  const projectId = `${today}-meet-aside`;
  const captureId = `${today}-make-a-first-aside`;
  const firstProjectId = `${today}-open-a-project-thread`;
  const scheduleId = `${today}-block-time-on-the-calendar`;

  const variables: Record<string, string> = {
    TIMESTAMP: formatTimestamp(now),
    MONDAY: formatDate(monday),
    SUNDAY: formatDate(sunday),
    WEEK_NUM: String(getWeekNumber(now)),
    PROJECT_ID: projectId,
    ACTION_ID_CAPTURE: captureId,
    ACTION_ID_PROJECT: firstProjectId,
    ACTION_ID_SCHEDULE: scheduleId,
  };

  for (const directory of [join(dataDir, 'notes', notesYear), join(dataDir, 'projects', year), join(dataDir, 'actions', year)]) {
    mkdirSync(assertManagedPath(dataDir, directory, 'directory', true), { recursive: true });
  }

  const fileMap: Record<string, string> = {
    'notes/index.yaml': `notes/${notesYear}/index.yaml`,
    'notes/week.md': `notes/${notesYear}/${variables.MONDAY}.md`,
    'projects/index.yaml': `projects/${year}/index.yaml`,
    'projects/project.md': `projects/${year}/${projectId}.md`,
    'actions/index.yaml': `actions/${year}/index.yaml`,
    'actions/capture-entry.md': `actions/${year}/${captureId}.md`,
    'actions/start-project.md': `actions/${year}/${firstProjectId}.md`,
    'actions/schedule-action.md': `actions/${year}/${scheduleId}.md`,
  };

  for (const [templateKey, targetPath] of Object.entries(fileMap)) {
    const rendered = render(TEMPLATES[templateKey], variables);
    writeFileCrashSafe(join(dataDir, targetPath), rendered, dataDir);
    created.push(targetPath);
    onCreated?.(targetPath);
  }

  return { created, dataDir, tutorial: { projectId } };
}

export function runInit(args: CommandInput): void {
  const options = parseCommand('instance', Array.isArray(args) ? ['init', ...args] : args);
  if (options.helpText) { console.log(options.helpText); return; }
  const directory = options.get('--dir')!;
  const name = options.get('--name')!;
  const description = options.get('--description')!;
  const result = init(resolve(directory), { name, description, body: options.get('--body'), tutorial: options.has('--tutorial') });
  publishReport({ title: 'Aside instance created', data: result,
    sections: [{ name: 'Information', fields: { Directory: result.dataDir } },
      { name: 'Created files', entries: result.created.map(name => ({ name })) }], checks: [] }, 'instance init', options.has('--json'));
}

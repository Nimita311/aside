import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { formatUtcTimestamp } from '../src/core/date.js';

export const DAY = '2026-06-09';
export const SINCE = '2026-06-09';
export interface Project { id: string; name: string; body: string; description: string; closed: boolean; related: string[] }
export interface Action { id: string; name: string; body: string; description: string; deadline: string | null; unfinished: boolean }
export interface Artifact { id: string; description: string }
export interface Entry { id: string; content: string; projects: string[]; actions: string[]; mentionedProjects: string[] }
export interface Fixture {
  projects: Project[]; actions: Action[]; artifacts: Artifact[]; entries: Entry[];
  projectActions: Map<string, Set<string>>; actionProjects: Map<string, Set<string>>;
  projectEntries: Map<string, Set<string>>; artifactProjects: Map<string, Set<string>>; artifactActions: Map<string, Set<string>>;
  focus: string;
}
const pad = (n: number) => String(n).padStart(5, '0');
const projectId = (p: number) => `2026-01-05-project-${pad(p)}`;
const actionId = (p: number, a: number) => `2026-01-05-action-${pad(p)}-${a}`;
const artifactId = (p: number, a: number) => `2026-01-05-artifact-${pad(p)}-${a}`;
function add(map: Map<string, Set<string>>, key: string, values: string[]) {
  const set = map.get(key) ?? new Set<string>();
  for (const value of values) set.add(value);
  map.set(key, set);
}

// Bulk-write deterministic native records outside the measured region. The
// expected graph is assembled from authored associations, never from Store.
export interface FixtureOptions { fanout?: number; bodyBytes?: number }
export function writeFixture(dir: string, size: number, options: FixtureOptions = {}): Fixture {
  if (!Number.isSafeInteger(size) || size < 40 || size > 100_000) throw new Error('Fixture size must be 40–100000 entries.');
  const fanout = options.fanout ?? 1, bodyBytes = options.bodyBytes ?? 0;
  if (!Number.isSafeInteger(fanout) || fanout < 1 || fanout > 8) throw new Error('Fixture fanout must be 1–8.');
  if (!Number.isSafeInteger(bodyBytes) || bodyBytes < 0 || bodyBytes > 65_536) throw new Error('Fixture bodyBytes must be 0–65536.');
  const padding = bodyBytes ? `\n\n${'x'.repeat(bodyBytes)}` : '';
  const fixture: Fixture = {
    projects: [], actions: [], artifacts: [], entries: [], focus: projectId(2),
    projectActions: new Map(), actionProjects: new Map(), projectEntries: new Map(), artifactProjects: new Map(), artifactActions: new Map(),
  };
  const projectCount = Math.ceil(size / 10);
  const indexes = new Map<string, { id: string; description: string }[]>();
  const writeRecord = (kind: string, id: string, fm: object, body: string, description: string) => {
    const folder = join(dir, kind, id.slice(0, 4));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${id}.md`), `---\n${stringify(fm)}---\n\n${body}\n`);
    addIndex(folder, id, description);
  };
  const addIndex = (folder: string, id: string, description: string) => {
    const items = indexes.get(folder) ?? [];
    items.push({ id, description }); indexes.set(folder, items);
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'aside.md'), '---\nid: canonical-query-benchmark\nname: Canonical query benchmark\ndescription: Disposable deterministic records\n---\n');
  for (let p = 0; p < projectCount; p++) {
    const id = projectId(p), next = projectId((p + 1) % projectCount);
    const related = p % 2 === 0 || p === 1 || p === projectCount - 1 ? [next] : [];
    const body = `Project ${p} context.\n\nid: this is authored prose, not a record header.\n\nPlan #artifact/${artifactId(p, 1)}.${padding}`;
    fixture.projects.push({ id, name: `Project ${p}`, body, description: `Work stream ${p}`, closed: p % 5 === 4, related });
    writeRecord('projects', id, {
      name: `Project ${p}`, created: '2026-01-05T09:00',
      ...(p % 5 === 4 ? { ended: '2026-06-01T09:00' } : {}),
      ...(related.length ? { related_projects: related.map(project => ({ project, description: 'Related work' })) } : {}),
    }, body, `Work stream ${p}`);
    for (let a = 0; a < 4; a++) {
      const id = actionId(p, a), name = `${a === 0 || a === 3 ? 'Review migration' : a === 1 ? 'Schedule' : 'Archive'} ${p}-${a}`;
      const deadline = a === 0 ? '2026-06-05' : a === 1 ? '2026-06-12' : a === 2 ? '2026-06-04' : null;
      const resolution = a === 2 ? 'done' : a === 3 && p % 4 === 0 ? 'cancelled' : undefined;
      const body = (a === 2 ? `Delivered #artifact/${artifactId(p, 1)}.` : 'Review the plan and record a decision.') + padding;
      fixture.actions.push({ id, name, body, description: `Task ${p}-${a}`, deadline, unfinished: !resolution });
      writeRecord('actions', id, { name, created: '2026-01-05T09:00', ...(deadline ? { deadline } : {}),
        ...(a === 1 ? { scheduled: '2026-06-11T10:00' } : {}), ...(resolution ? { resolution } : {}),
      }, body, `Task ${p}-${a}`);
      if (a === 2) add(fixture.artifactActions, artifactId(p, 1), [id]);
    }
    for (let a = 0; a < 2; a++) {
      const id = artifactId(p, a), description = `Plan ${p}-${a}`;
      fixture.artifacts.push({ id, description });
      writeRecord('artifacts', id, { name: `Plan ${p}-${a}`, created: '2026-01-05T09:00' }, `# Plan ${p}-${a}\n\nSupporting context.${padding}`, description);
      if (a === 1) add(fixture.artifactProjects, id, [projectId(p)]);
    }
  }
  const weeks = new Map<string, { monday: Date; entries: Entry[] }>();
  for (let e = 0; e < size; e++) {
    const p = Math.floor(e / 10), next = projectId((p + 1) % projectCount);
    const inline = e % 10 === 8 && p % 4 === 1;
    const recent = inline || p % 3 !== 0 && e % 4 === 0;
    const date = new Date(Date.UTC(2026, recent ? 5 : 0, inline ? 11 : recent ? 10 : 5, 0, e));
    const id = formatUtcTimestamp(date);
    const orphan = e % 25 === 0;
    const projects = orphan ? [] : [...new Set([
      ...Array.from({ length: fanout }, (_, i) => projectId((p + i) % projectCount)),
      ...(e % 10 === 6 && p % 4 === 1 ? [next] : []),
    ])];
    const actions = [orphan ? `2026-01-05-orphan-${pad(e)}` : actionId(p, e % 4)];
    if (orphan) {
      const name = `Unassigned review ${e}`;
      fixture.actions.push({ id: actions[0], name, body: `Standalone work.${padding}`, description: `Unassigned task ${e}`, deadline: null, unfinished: true });
      writeRecord('actions', actions[0], { name, created: '2026-01-05T09:00' }, `Standalone work.${padding}`, `Unassigned task ${e}`);
    }
    const mentionedProjects = inline ? [next] : [];
    const content = `Progress ${e}. #artifact/${artifactId(p, 0)}${mentionedProjects.length ? `\n\nMention #project/${next}.` : ''}\n\nCode example: \`#artifact/${artifactId(p, 1)}\`.${padding}`;
    const entry = { id, content, projects, actions, mentionedProjects };
    fixture.entries.push(entry);
    for (const project of [...projects, ...mentionedProjects]) add(fixture.projectEntries, project, [id]);
    for (const project of projects) { add(fixture.projectActions, project, actions); for (const action of actions) add(fixture.actionProjects, action, [project]); }
    add(fixture.artifactProjects, artifactId(p, 0), projects); add(fixture.artifactActions, artifactId(p, 0), actions);
    const monday = new Date(date); monday.setUTCHours(0, 0, 0, 0); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
    const week = formatUtcTimestamp(monday).slice(0, 10);
    const group = weeks.get(week) ?? { monday, entries: [] }; group.entries.push(entry); weeks.set(week, group);
    const folder = join(dir, 'notes', week.slice(0, 4)); mkdirSync(folder, { recursive: true }); addIndex(folder, id, `Progress ${e}`);
  }
  for (const [week, { monday, entries }] of weeks) {
    const sunday = new Date(monday); sunday.setUTCDate(sunday.getUTCDate() + 6);
    const thursday = new Date(monday); thursday.setUTCDate(thursday.getUTCDate() + 3);
    const weekNumber = Math.ceil(((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
    const blocks = entries.sort((a, b) => b.id.localeCompare(a.id)).map(entry => `---\n\`\`\`entry\n${stringify({ created: entry.id, projects: entry.projects, actions: entry.actions })}\`\`\`\n\n${entry.content}`);
    writeFileSync(join(dir, 'notes', week.slice(0, 4), `${week}.md`), `---\n${stringify({ week: weekNumber, week_start: week, week_end: formatUtcTimestamp(sunday).slice(0, 10) })}---\n\n${blocks.join('\n\n')}\n`);
  }
  for (const [folder, items] of indexes) writeFileSync(join(folder, 'index.yaml'), stringify(items.sort((a, b) => b.id.localeCompare(a.id))));
  return fixture;
}

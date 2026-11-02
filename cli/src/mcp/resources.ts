import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQLSchemaResult } from '../graphql/schema.js';
import skill from '../../../agent/graphql/skills/aside/SKILL.md';
import about from './resources/about.md';
import records from './resources/records.md';
import planning from './resources/planning.md';
import automate from './resources/automate.md';
import setup from './resources/setup.md';
import sessionRules from './resources/shared/session.md';
import authoringRules from './resources/shared/authoring.md';

// A write guide arrives with its authoring rules in one resource read. Keep the
// shared section in one source instead of copying it into each task file.
const withAuthoring = (guide: string): string => `${guide.trimEnd()}\n\n${authoringRules.trim()}\n`;

// Embed guides in the bundle, independently of the installed skill.
// All clients, including clients without skills, can discover the same surface.
export const GRAPHQL_GUIDES = [
  { name: 'records', title: 'Find, capture, and edit records', description: 'Recall, search, count, validate, capture conversations, or edit record content, projects, artifacts, and attachments. Includes creating actions in context and opening browser views with show or showUrl.', text: withAuthoring(records) },
  { name: 'planning', title: 'Plan, schedule, and repeat work', description: 'Review priorities and deadlines; schedule or resolve actions, manage recurring commitments, or diagnose Calendar sync. Includes creating work during planning.', text: withAuthoring(planning) },
  { name: 'automate', title: 'Automate work', description: 'Schedule scripts or agents, delegate action work, choose models, force delegation execution, and inspect retained runs and logs.', text: withAuthoring(automate) },
  { name: 'setup', title: 'Set up and configure an instance', description: 'Choose or create an instance, edit its instructions, Calendar title prefixes, and settings, and configure startup discovery.', text: withAuthoring(setup) },
  { name: 'about', title: 'About Aside', description: 'Deeper design rationale: plain text ownership, recurrence versus automation, shared architecture, and instance boundaries.', text: about },
] as const;

// Clients without skills need the same foundation. Embed its body from the
// installed package's source so record semantics and routing cannot drift.
const skillBody = skill.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
export const GRAPHQL_SERVER_INSTRUCTIONS = `${skillBody}\n\n${sessionRules.trim()}`;

export function registerGraphQLResources(server: McpServer, readSchema: () => Promise<GraphQLSchemaResult>): void {
  for (const guide of GRAPHQL_GUIDES) {
    server.registerResource(guide.name, `aside://docs/${guide.name}`, {
      title: guide.title, description: guide.description, mimeType: 'text/markdown',
    }, async uri => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: guide.text }] }));
  }

  server.registerResource('graphql-schema', 'aside://graphql/schema', {
    title: 'Aside GraphQL schema',
    description: 'Stable documented SDL shared across instances. Prefer query introspection for a few known types. Discover selectable models through Instance.execution.models; schema reads do not probe vendors or load records. Session diagnostics appear as comments.',
    mimeType: 'application/graphql',
  }, async uri => {
    const {sdl, diagnostics} = await readSchema();
    // Preserve session diagnostics as comments without changing the static SDL.
    const warning = diagnostics.length > 0
      ? '# Schema discovery diagnostics.\n'
        + JSON.stringify({ complete: false, diagnostics }, null, 2)
          .split(/\r?\n/).map(line => `# ${line}`).join('\n') + '\n\n'
      : '';
    return { contents: [{ uri: uri.href, mimeType: 'application/graphql', text: warning + sdl }] };
  });
}

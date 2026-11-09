// Node-only entry. None of these modules are imported by the production UI.
export { loadFixture, FIXTURE_NAMES, SHOWCASE_IDS, MOCK_NOW } from './fixture-store.ts';
export { scenarios } from './scenarios.ts';
export { parseFileGrantPath, verifyFileGrant } from '../../cli/src/web/file-grants.ts';
import { join } from 'node:path';
import { entityFilePath, weekFilePath } from '../../cli/src/core/record-reference.ts';
import { executeGraphQL } from '../../cli/src/graphql/schema.ts';
import { prepareWebQuery } from '../../cli/src/web/query.ts';
import { withClock } from './node-clock.mjs';
import { assertSidebarUnchanged, assertWebappSidebar, SidebarConflictError } from '../../cli/src/core/webapp-config.ts';
export { SidebarConflictError };

// A preview owns its snapshot. Sidebar writes never touch the immutable fixture
// files or construct a writable Store, and remain visible to later snapshots.
export function updateFixtureSidebar(fixture, value, expectedSidebar) {
  const sidebar = assertWebappSidebar(value);
  const instance = structuredClone(fixture.snapshot.instance);
  if (!instance) throw new Error('The fixture instance is unavailable.');
  if (fixture.snapshot.diagnostics.some(diagnostic => diagnostic.path === 'aside.md' && diagnostic.issues.some(issue =>
    ['invalid_yaml', 'read_error', 'not_a_mapping', 'invalid_webapp_config', 'invalid_webapp_sidebar'].includes(issue.code)))) {
    throw new SidebarConflictError('The current sidebar declaration cannot be verified. Ask the agent to repair the instance settings before pinning content.');
  }
  assertSidebarUnchanged(instance.manifest.config?.webapp?.sidebar ?? [], expectedSidebar);
  instance.manifest.config ??= {};
  instance.manifest.config.webapp ??= {};
  instance.manifest.config.webapp.sidebar = sidebar;
  fixture.snapshot = { ...fixture.snapshot, instance };
  return sidebar;
}

// Store construction reconciles files and persists daemon recurrence history.
// Webpage queries need only this immutable read surface over the parsed fixture.
function queryStore({store: core, root, snapshot, attachmentFiles, referenceRoots}) {
  const entries = new Map(core.getEntries().map(entry => [entry.meta.created, entry]));
  const entityFile = (kind, id, records) => records.has(id) ? join(root, entityFilePath(kind, id)) : undefined;
  return {
    getDataDir: () => root,
    getInstance: () => snapshot.instance,
    getIssues: () => core.getIssues(),
    getRelations: () => core.cachedRelations(),
    getEntries: () => core.getEntries(),
    getProjects: () => core.getProjects(),
    getActions: () => core.getActions(),
    getArtifacts: () => core.getArtifacts(),
    getNoteIndex: () => core.getNoteIndex(),
    getProjectIndex: () => core.getProjectIndex(),
    getActionIndex: () => core.getActionIndex(),
    getArtifactIndex: () => core.getArtifactIndex(),
    getEntryFile: id => entries.has(id) ? join(root, weekFilePath(entries.get(id).weekFile)) : undefined,
    getProjectFile: id => entityFile('project', id, core.getProjects()),
    getActionFile: id => entityFile('action', id, core.getActions()),
    getArtifactFile: id => entityFile('artifact', id, core.getArtifacts()),
    getAttachmentFiles: id => attachmentFiles.get(id) ?? [],
    getReferenceRoots: () => referenceRoots,
    getRevision: () => 0,
    getRecordRevision: () => 0,
    getIndexRevision: () => 0,
  };
}

export async function queryFixture(fixture, request, now) {
  const prepared = prepareWebQuery(request);
  if ('result' in prepared) return prepared.result;
  return withClock(now, async () => {
    return executeGraphQL(queryStore(fixture), 'query', prepared.args, {
      signal: AbortSignal.timeout(10_000), maxFields: 10_000, maxResponseBytes: 1024 * 1024,
    });
  });
}

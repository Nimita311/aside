import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { init } from '../src/commands/init.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { createArtifact } from '../src/mcp/tools/artifact.js';
import { handleUpdateEntry, handleUpdateProject } from '../src/mcp/tools/update.js';
import { artifactHandle } from '../src/core/artifact-reference.js';
import { executeGraphQL } from '../src/graphql/schema.js';

const linkFields = `__typename handle id description created filePath
  ... on Entry { content }
  ... on Project { name }
  ... on Action { name }
  ... on Artifact { name }`;
const attachmentFields = '__typename handle filename filePath';
const handle = (node: any) => node.handle;

describe('resolved GraphQL links and project relationships', () => {
  let root: string, store: Store, entry: string, projectA: string, projectB: string, action: string, plan: string, guide: string;
  const query = async (document: string) => {
    const result = await executeGraphQL(store, 'query', {document});
    expect(result.errors).toBeUndefined();
    return result;
  };
  beforeEach(() => {
    root = realpathSync(mkdtempSync('/tmp/aside-reference-integration-'));
    init(root, {name: 'Reference integration', description: 'Reference integration'});
    store = new Store(root);
    const captured = handleCapture(store, {content: 'Context', description: 'Context',
      projects: [{name: 'Overview', description: 'Overview'}, {name: 'Detail', description: 'Detail'}],
      actions: [{name: 'Review', description: 'Review'}],
    }, new Date(2026, 9, 2, 10));
    entry = captured.entryId; [projectA, projectB] = captured.createdProjectIds; [action] = captured.createdActionIds;
    plan = createArtifact(store, {name: 'Plan', description: 'Plan', body: `#entry/${entry}\n#action/${action}`}, new Date(2026, 9, 2, 11)).id;
    const file = join(root, 'notes v2.md'); writeFileSync(file, `#project/${projectB}`);
    guide = createArtifact(store, {name: 'Guide', description: 'Guide', files: [{source: file}]}, new Date(2026, 9, 2, 12)).id;
    handleUpdateEntry(store, {id: entry, content: `#project/${projectA}\n#action/${action}\n#artifact/${plan}\n[Guide](${artifactHandle(guide, 'notes v2.md')})\n#project/${projectA}`});
  });
  afterEach(() => { store.close(); rmSync(root, {recursive: true, force: true}); });

  it('returns typed direct targets with exact attachment identity and independent page metadata', async () => {
    const result = await query(`{ entry(id: "${entry}") {
      projects { totalCount }
      links(offset: 1, limit: 2) { offset count totalCount nodes { ${linkFields} } }
      attachmentLinks { offset count totalCount nodes { ${attachmentFields} } }
    } }`);
    const value = result.data!.entry as any;
    expect(value.projects.totalCount).toBe(2);
    expect(value.links).toMatchObject({offset: 1, count: 2, totalCount: 3});
    expect(value.links.nodes.map((node: any) => node.__typename)).toEqual(['Artifact', 'Project']);
    expect(value.links.nodes[0]).toMatchObject({id: plan, handle: `#artifact/${plan}`});
    expect(value.links.nodes[1]).toMatchObject({id: projectA, handle: `#project/${projectA}`});
    expect(value.attachmentLinks).toEqual({offset: 0, count: 1, totalCount: 1, nodes: [{__typename: 'Attachment', filename: 'notes v2.md', handle: artifactHandle(guide, 'notes v2.md'), filePath: join(root, `artifacts/2026/${guide}/notes v2.md`)}]});
    expect(result.extensions!.complete).toBe(true);
  });

  it('exposes exact forward and backward references on each record kind', async () => {
    const result = await query(`{
      entry(id: "${entry}") { backlinks { nodes { ${linkFields} } } }
      project(id: "${projectA}") { links { totalCount } backlinks { nodes { ${linkFields} } } }
      action(id: "${action}") { backlinks { nodes { ${linkFields} } } }
      artifact(id: "${plan}") { links { nodes { ${linkFields} } } backlinks { nodes { ${linkFields} } } }
    }`);
    const data = result.data as any;
    expect(data.entry.backlinks.nodes.map(handle)).toEqual([`#artifact/${plan}`]);
    expect(data.project.links.totalCount).toBe(0);
    expect(data.project.backlinks.nodes.map(handle)).toEqual([`#entry/${entry}`]);
    expect(data.action.backlinks.nodes.map(handle)).toEqual([`#artifact/${plan}`, `#entry/${entry}`]);
    expect(data.artifact.links.nodes.map(handle)).toEqual([`#action/${action}`, `#entry/${entry}`]);
    expect(data.artifact.backlinks.nodes.map(handle)).toEqual([`#entry/${entry}`]);
  });

  it('keeps attachment target backlinks separate and never treats file content as a source', async () => {
    const result = await query(`{
      artifact(id: "${guide}") {
        links { nodes { ${linkFields} } }
        backlinks { nodes { ${linkFields} } }
        entries { nodes { id } }
        projects { nodes { id } }
        content { ... on Attachment { backlinks { nodes { ${linkFields} } } } }
        attachments { backlinks { nodes { ${linkFields} } } }
      }
      entry(id: "${entry}") { artifacts { nodes { id } } }
      project(id: "${projectB}") { backlinks { nodes { ${linkFields} } } }
    }`);
    const data = result.data as any;
    expect(data.artifact.links.nodes).toEqual([]);
    expect(data.artifact.content.backlinks.nodes.map(handle)).toEqual([`#entry/${entry}`]);
    expect(data.artifact.attachments[0].backlinks).toEqual(data.artifact.content.backlinks);
    expect(data.artifact.backlinks.nodes).toEqual([]);
    expect(data.artifact.entries.nodes).toEqual([{id: entry}]);
    expect(data.artifact.projects.nodes.map((node: any) => node.id).sort()).toEqual([projectA, projectB].sort());
    expect(data.entry.artifacts.nodes.map((node: any) => node.id).sort()).toEqual([plan, guide].sort());
    expect(data.project.backlinks.nodes).toEqual([]);
  });

  it('omits missing targets before count and exposes source-file diagnostics and validation', async () => {
    const file = store.getProjectFile(projectA)!;
    const project = store.getProject(projectA)!;
    store.saveProject(projectA, {...project.frontMatter, related_projects: [{project: '2026-10-02-missing', description: 'Missing'}]}, '#action/2026-10-02-missing\n#action/2026-10-02-missing', file);
    const result = await query(`{
      project(id: "${projectA}") { links { nodes { ${linkFields} } count totalCount } relatedProjects { count totalCount nodes { project { id } } } }
      activeInstance { validation { checks { name passed details } } }
    }`);
    const data = result.data as any;
    expect(data.project.links).toEqual({nodes: [], count: 0, totalCount: 0});
    expect(data.project.relatedProjects).toEqual({nodes: [], count: 0, totalCount: 0});
    expect(result.extensions!.complete).toBe(false);
    expect(result.extensions!.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({file, message: expect.stringContaining('#action/2026-10-02-missing')})]));
    const checks = data.activeInstance.validation.checks;
    expect(checks.find((check: any) => check.name === 'Inline mentions reference existing entities')).toMatchObject({passed: false, details: [expect.stringContaining(`projects/2026/${projectA}.md`)]});
    expect(checks.find((check: any) => check.name === 'Related projects reference existing projects').details).toContain(`projects/2026/${projectA}.md: related project '2026-10-02-missing' not found`);
  });

  it('omits unavailable file targets from contextual artifact collections', async () => {
    handleUpdateEntry(store, {id: entry, content: `#artifact/${guide}/missing.md`});
    handleUpdateProject(store, {id: projectA, body: `#artifact/${guide}/missing.md`});
    const result = await query(`{
      entry(id: "${entry}") { artifacts { totalCount } attachmentLinks { totalCount } }
      project(id: "${projectA}") { artifacts { totalCount } attachmentLinks { totalCount } }
      artifact(id: "${guide}") { entries { totalCount } projects { totalCount } backlinks { totalCount } }
    }`);
    expect(result.data).toEqual({
      entry: {artifacts: {totalCount: 0}, attachmentLinks: {totalCount: 0}},
      project: {artifacts: {totalCount: 0}, attachmentLinks: {totalCount: 0}},
      artifact: {entries: {totalCount: 0}, projects: {totalCount: 0}, backlinks: {totalCount: 0}},
    });
    expect(result.extensions!.complete).toBe(false);
    expect((result.extensions!.diagnostics as any[]).some(issue => issue.message.includes('missing.md'))).toBe(true);
  });

  it('merges reciprocal declarations once, retaining both descriptions and target filters before paging', async () => {
    handleUpdateProject(store, {id: projectA, related_projects: [{project: projectB, description: 'Discover detail'}]});
    handleUpdateProject(store, {id: projectB, related_projects: [{project: projectA, description: 'Discover overview'}]});
    const result = await query(`{
      project(id: "${projectA}") { relatedProjects(where: {ids: ["${projectB}"]}, limit: 1) {
        nodes { project { id name } direction outgoingDescription incomingDescription }
        offset count totalCount
      } }
    }`);
    expect((result.data!.project as any).relatedProjects).toEqual({nodes: [{project: {id: projectB, name: 'Detail'}, direction: 'BIDIRECTIONAL', outgoingDescription: 'Discover detail', incomingDescription: 'Discover overview'}], offset: 0, count: 1, totalCount: 1});
    handleUpdateProject(store, {id: projectB, related_projects: []});
    const oneWay = await query(`{ first: project(id: "${projectA}") { relatedProjects { nodes { direction outgoingDescription incomingDescription } } } second: project(id: "${projectB}") { relatedProjects { nodes { direction outgoingDescription incomingDescription } } } }`);
    expect((oneWay.data!.first as any).relatedProjects.nodes).toEqual([{direction: 'OUTGOING', outgoingDescription: 'Discover detail', incomingDescription: null}]);
    expect((oneWay.data!.second as any).relatedProjects.nodes).toEqual([{direction: 'INCOMING', outgoingDescription: null, incomingDescription: 'Discover detail'}]);
  });

  it('filters relatedTo through existing outgoing targets, excluding missing, self, and reverse declarations', async () => {
    const missing = '2026-10-02-missing';
    const file = store.getProjectFile(projectA)!;
    const project = store.getProject(projectA)!;
    const invalid = [{project: missing, description: 'Missing'}, {project: projectA, description: 'Self'}];
    store.saveProject(projectA, {...project.frontMatter, related_projects: [
      ...invalid, {project: projectB, description: 'Discover detail'},
    ]}, project.body, file);
    const supportingFile = join(root, 'unreferenced.md'); writeFileSync(supportingFile, Buffer.from([255]));
    createArtifact(store, {name: 'Supporting file', description: 'Unindexed Markdown probe', body: 'Primary body', files: [{source: supportingFile}]});
    const countOnly = await query(`{ projects(where: {ids: ["${projectA}"], relatedTo: ["${projectB}"]}) { totalCount } }`);
    expect(countOnly.data!.projects).toEqual({totalCount: 1});
    expect(countOnly.extensions!.complete).toBe(false);
    expect(countOnly.extensions!.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'graphql_missing_relationship_target', file, message: expect.stringContaining(missing)}),
    ]));
    expect((countOnly.extensions!.diagnostics as any[]).some(issue => issue.code === 'content_reference_read_error')).toBe(false);
    const scanned = await query(`{ project(id: "${projectA}") { links { totalCount } } }`);
    expect((scanned.extensions!.diagnostics as any[]).some(issue => issue.code === 'content_reference_read_error')).toBe(false);
    const result = await query(`{
      missing: projects(where: {ids: ["${projectA}"], relatedTo: ["${missing}"]}) { nodes { id } totalCount }
      self: projects(where: {ids: ["${projectA}"], relatedTo: ["${projectA}"]}) { nodes { id } totalCount }
      valid: projects(where: {ids: ["${projectA}"], relatedTo: ["${projectB}"]}) { nodes { id } totalCount }
      reverse: projects(where: {ids: ["${projectB}"], relatedTo: ["${projectA}"]}) { nodes { id } totalCount }
      empty: projects(where: {ids: ["${projectA}", "${projectB}"], relatedTo: []}) { nodes { id } totalCount }
    }`);
    const data = result.data as any;
    expect(data.missing).toEqual({nodes: [], totalCount: 0});
    expect(data.self).toEqual({nodes: [], totalCount: 0});
    expect(data.valid).toEqual({nodes: [{id: projectA}], totalCount: 1});
    expect(data.reverse).toEqual({nodes: [], totalCount: 0});
    expect(data.empty).toEqual({nodes: [{id: projectB}], totalCount: 1});
    expect(result.extensions!.complete).toBe(false);
    expect(result.extensions!.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'graphql_missing_relationship_target', file, message: expect.stringContaining(missing)}),
    ]));

    handleUpdateProject(store, {id: projectB, related_projects: [{project: projectA, description: 'Discover overview'}]});
    const reciprocal = await query(`{ projects(where: {ids: ["${projectA}"], relatedTo: ["${projectB}"]}) { nodes { id } totalCount } }`);
    expect((reciprocal.data as any).projects).toEqual({nodes: [{id: projectA}], totalCount: 1});

    store.saveProject(projectA, {...project.frontMatter, related_projects: invalid}, project.body, file);
    const invalidOnly = await query(`{ projects(where: {ids: ["${projectA}"], relatedTo: []}) {
      nodes { id relatedProjects { nodes { direction } totalCount } } totalCount
    } }`);
    expect((invalidOnly.data as any).projects).toEqual({nodes: [{id: projectA,
      relatedProjects: {nodes: [{direction: 'INCOMING'}], totalCount: 1},
    }], totalCount: 1});
  });

  it('resolves relative and absolute record file links and ignores outside URLs', async () => {
    const record = store.getArtifact(plan)!;
    store.saveArtifact(plan, record.frontMatter, `[Project](../../projects/2026/${projectA}.md)\n[Action](${store.getActionFile(action)})\n[Outside](/outside/actions/2026/${action}.md)`, store.getArtifactFile(plan)!);
    const before = readFileSync(store.getArtifactFile(plan)!, 'utf8');
    const result = await query(`{ artifact(id: "${plan}") { links { count totalCount nodes { ${linkFields} } } } }`);
    expect((result.data!.artifact as any).links.nodes.map(handle)).toEqual([`#action/${action}`, `#project/${projectA}`]);
    expect(result.extensions!.complete).toBe(true);
    expect(readFileSync(store.getArtifactFile(plan)!, 'utf8')).toBe(before);
  });
});

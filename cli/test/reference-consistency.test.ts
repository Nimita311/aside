import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { init } from '../src/commands/init.js';
import { entryEntityIds, entryReferences } from '../src/core/record-reference.js';
import { extractArtifactReferences } from '../src/core/artifact-reference.js';
import { validate } from '../src/core/validator.js';
import { Store } from '../src/mcp/store.js';
import { handleCapture } from '../src/mcp/tools/capture.js';
import { createArtifact } from '../src/mcp/tools/artifact.js';
import { executeGraphQL } from '../src/graphql/schema.js';

describe('code-formatted entity references', () => {
  const handles = '#project/2026-10-10-example #action/2026-10-10-example';

  it.each([
    `\`${handles}\``,
    `\`\`literal \` ${handles}\`\``,
    `\`\`\`md\n${handles}\n\`\`\``,
    `~~~~\n${handles}\n~~~~`,
    `\`\`\`\`md\n\`\`\`\n${handles}\n\`\`\`\``,
    `> \`\`\`md\n> ${handles}\n> \`\`\``,
    `- \`\`\`md\n  ${handles}\n  \`\`\``,
    `    ${handles}`,
    `\t${handles}`,
    `<code>${handles}</code>`,
    `<pre class="sample">${handles}</pre>`,
  ])('keeps code examples out of inline relationships: %s', code => {
    const entry = {
      meta: { created: '2026-10-10T09:00', projects: ['explicit-project'], actions: ['explicit-action'] },
      content: `${code}\nProse #project/real-project and #action/real-action.`,
    };
    expect(entryEntityIds(entry, 'project')).toEqual(['explicit-project', 'real-project']);
    expect(entryEntityIds(entry, 'action')).toEqual(['explicit-action', 'real-action']);
    expect(entryReferences(entry, {type: 'project', id: '2026-10-10-example'})).toBe(false);
    expect(entryReferences(entry, {type: 'action', id: '2026-10-10-example'})).toBe(false);
  });

  it('preserves authored references beside unmatched backticks and after ended code containers', () => {
    for (const code of [
      '`unmatched',
      '> ```md\n> code',
      '- ```md\n  code',
    ]) {
      const entry = {meta: {created: '2026-10-10T09:00'}, content: `${code}\n${handles}`};
      expect(entryEntityIds(entry, 'project')).toEqual(['2026-10-10-example']);
      expect(entryEntityIds(entry, 'action')).toEqual(['2026-10-10-example']);
    }
  });

  it.each([
    `Discussed work:\n    ${handles} #artifact/2026-10-10-example`,
    `Discussed work:\n\t${handles} #artifact/2026-10-10-example`,
    `First unmatched \`\n\n${handles} #artifact/2026-10-10-example\n\nLater unmatched \``,
    `> First unmatched \`\n>\n> ${handles} #artifact/2026-10-10-example\n>\n> Later unmatched \``,
  ])('retains visible references in paragraph continuations and separate blocks: %s', content => {
    const entry = {meta: {created: '2026-10-10T09:00'}, content};
    expect(entryEntityIds(entry, 'project')).toEqual(['2026-10-10-example']);
    expect(entryEntityIds(entry, 'action')).toEqual(['2026-10-10-example']);
    expect(extractArtifactReferences(content)).toEqual([{id: '2026-10-10-example'}]);
  });

  it('excludes escaped handles, external URI fragments, and independent link-label mentions while preserving tags', () => {
    const entry = {meta: {created: '2026-10-10T09:00', projects: ['tagged-project'], actions: ['tagged-action']}, content: [
      '\\#project/literal-project \\#action/literal-action',
      'https://outside.test/?target=#project/url-project',
      'https://outside.test/?target=#action/url-action',
      '[Label #project/label-project](https://outside.test/)',
      '[Label #action/label-action](#project/linked-project)',
      '[Action](#action/linked-action)',
      '#project/bare-project, #action/bare-action.',
    ].join('\n')};
    expect(entryEntityIds(entry, 'project')).toEqual(['tagged-project', 'linked-project', 'bare-project']);
    expect(entryEntityIds(entry, 'action')).toEqual(['tagged-action', 'linked-action', 'bare-action']);
    for (const id of ['literal-project', 'url-project', 'label-project']) expect(entryReferences(entry, {type: 'project', id})).toBe(false);
    for (const id of ['literal-action', 'url-action', 'label-action']) expect(entryReferences(entry, {type: 'action', id})).toBe(false);
  });
});

describe('GraphQL reference consistency', () => {
  let dir: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync('/private/tmp/aside-reference-consistency-');
    init(dir, {name: 'Reference consistency', description: 'Disposable regression fixture'});
    store = new Store(dir);
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
    rmSync(dir, {recursive: true, force: true});
  });

  const query = async (document: string) => {
    const result = await executeGraphQL(store, 'query', {document});
    expect(result.errors).toBeUndefined();
    return result.data as any;
  };

  it('keeps entry context and direct links consistent for escaped and URL-contained handles', async () => {
    const context = handleCapture(store, {content: 'Authoritative context', description: 'Context',
      projects: [{name: 'Project', description: 'Project'}], actions: [{name: 'Action', description: 'Action'}],
    }, new Date(2026, 9, 10, 9));
    const project = context.createdProjectIds[0], action = context.createdActionIds[0];
    const literal = handleCapture(store, {description: 'Literal and external references', content: [
      `\\#project/${project} \\#action/${action}`,
      `https://outside.test/?target=#project/${project}`,
      `https://outside.test/?target=#action/${action}`,
      `[Label #project/${project}](https://outside.test/)`,
      `[Label #action/${action}](https://outside.test/)`,
    ].join('\n')}, new Date(2026, 9, 10, 10));
    const linked = handleCapture(store, {description: 'Visible references', content: `[Project](#project/${project}) and #action/${action}.`}, new Date(2026, 9, 10, 11));
    const data = await query(`{
      project(id: "${project}") { entries { nodes { id } } backlinks { totalCount } }
      action(id: "${action}") { entries { nodes { id } } backlinks { totalCount } }
      entry(id: "${literal.entryId}") { links { totalCount } }
    }`);
    expect(data.entry.links.totalCount).toBe(0);
    for (const record of [data.project, data.action]) {
      expect(record.entries.nodes).toEqual([{id: linked.entryId}, {id: context.entryId}]);
      expect(record.backlinks.totalCount).toBe(1);
    }
    expect(validate(dir).checks.find(check => check.name === 'Inline mentions reference existing entities')?.passed).toBe(true);
  });

  it('excludes literal code from backlinks and missing-reference validation while preserving prose and tags', async () => {
    const context = handleCapture(store, {
      content: 'Create context.', description: 'Context',
      projects: [{name: 'Project', description: 'Project context'}],
      actions: [{name: 'Action', description: 'Action context'}],
    }, new Date(2026, 9, 10, 9));
    const project = context.createdProjectIds[0], action = context.createdActionIds[0];
    const literal = handleCapture(store, {
      content: `\`#project/${project}\` and \`#action/${action}\`.\n\`#project/missing-project\` and \`#action/missing-action\`.`,
      description: 'Literal references',
    }, new Date(2026, 9, 10, 10));
    const tagged = handleCapture(store, {
      content: `\`#project/${project}\` and \`#action/${action}\`.`, description: 'Explicit tags',
      projects: [project], actions: [action],
    }, new Date(2026, 9, 10, 11));
    const inlineCheck = () => validate(dir).checks.find(check => check.name === 'Inline mentions reference existing entities')!;
    expect(inlineCheck().passed).toBe(true);

    const entries = await query(`{
      project(id: "${project}") { entries { nodes { id } } }
      action(id: "${action}") { entries { nodes { id } } }
    }`);
    for (const record of [entries.project, entries.action]) {
      expect(record.entries.nodes.map((node: any) => node.id)).toEqual([tagged.entryId, context.entryId]);
      expect(record.entries.nodes.map((node: any) => node.id)).not.toContain(literal.entryId);
    }

    const prose = handleCapture(store, {
      content: `See #project/${project} and #action/${action}; #project/missing-project and #action/missing-action.`,
      description: 'Authored references',
    }, new Date(2026, 9, 10, 12));
    const after = await query(`{
      project(id: "${project}") { entries(where: {ids: ["${prose.entryId}"]}) { totalCount } }
      action(id: "${action}") { entries(where: {ids: ["${prose.entryId}"]}) { totalCount } }
    }`);
    expect(after.project.entries.totalCount).toBe(1);
    expect(after.action.entries.totalCount).toBe(1);
    expect(inlineCheck()).toMatchObject({passed: false, details: [
      expect.stringContaining('references missing project #project/missing-project'),
      expect.stringContaining('references missing action #action/missing-action'),
    ]});
  });

  it('inherits template body and tagged-entry artifacts for projections without adding graph links', async () => {
    const bodyArtifact = createArtifact(store, {name: 'Body artifact', description: 'Body source', body: 'Instructions'}).id;
    const contextArtifact = createArtifact(store, {name: 'Context artifact', description: 'Context source', body: 'Supporting context'}).id;
    const context = handleCapture(store, {
      content: `Define the repeating task using #artifact/${contextArtifact}.`, description: 'Recurring context',
      projects: [{name: 'Project', description: 'Task project'}],
      actions: [{
        name: 'Task', description: 'Recurring task', body: `Read #artifact/${bodyArtifact}.`,
        recurrence: [{dtstart: '2099-01-01', rrule: 'FREQ=DAILY'}],
      }],
    });
    const template = context.createdActionIds[0];
    const relations = store.getRelations();
    const before = {
      backlinks: structuredClone(relations.artifactBacklinks),
      artifactActions: structuredClone(relations.actionsByArtifact),
      actions: store.getActions().size,
    };
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2098-12-31T12:00:00Z'));
    const data = await query(`{
      action(id: "${template}") { body artifacts { totalCount nodes { id } } }
      actions(where: {occurrence: {projected: true}, scheduledFrom: "2099-01-01", scheduledTo: "2099-01-01"}) {
        nodes { occurrence { projected }
          body projects { totalCount }
          artifacts { totalCount nodes { id } }
          bodyArtifact: artifacts(where: {ids: ["${bodyArtifact}"]}) { totalCount nodes { id } }
          contextArtifact: artifacts(where: {ids: ["${contextArtifact}"]}, limit: 1) { totalCount offset count nodes { id } }
        }
      }
      bodyArtifact: artifact(id: "${bodyArtifact}") { backlinks { nodes { ... on Action { handle } } } actions(where: {ids: ["${template}"]}) { nodes { id } } }
    }`);
    expect(data.actions.nodes).toHaveLength(1);
    const projection = data.actions.nodes[0];
    expect(projection.occurrence.projected).toBe(true);
    expect(projection.body).toBe(data.action.body);
    expect(projection.projects.totalCount).toBe(1);
    expect(projection.artifacts).toEqual(data.action.artifacts);
    expect(projection.artifacts.totalCount).toBe(2);
    expect(projection.bodyArtifact).toMatchObject({totalCount: 1, nodes: [{id: bodyArtifact}]});
    expect(projection.contextArtifact).toMatchObject({totalCount: 1, offset: 0, count: 1, nodes: [{id: contextArtifact}]});
    expect(data.bodyArtifact.backlinks.nodes).toEqual([{handle: `#action/${template}`}]);
    expect(data.bodyArtifact.actions.nodes).toEqual([{id: template}]);
    expect(store.getRelations()).toBe(relations);
    expect(relations.artifactBacklinks).toEqual(before.backlinks);
    expect(relations.actionsByArtifact).toEqual(before.artifactActions);
    expect(store.getActions().size).toBe(before.actions);
  });

  it('does not pair unmatched inline backticks across separate entry bodies', () => {
    handleCapture(store, {
      content: '#project/missing-project `', description: 'One unmatched backtick',
    }, new Date(2026, 9, 10, 9));
    handleCapture(store, {
      content: '` #action/missing-action', description: 'Another unmatched backtick',
    }, new Date(2026, 9, 10, 10));
    const check = validate(dir).checks.find(check => check.name === 'Inline mentions reference existing entities');
    expect(check).toMatchObject({passed: false, details: expect.arrayContaining([
      expect.stringContaining('references missing project #project/missing-project'),
      expect.stringContaining('references missing action #action/missing-action'),
    ])});
    expect(check!.details).toHaveLength(2);
  });

  it('validates visible references on indented continuations and between unmatched paragraph delimiters', () => {
    handleCapture(store, {
      content: 'Discussed work:\n    #project/missing-project\n\nFirst unmatched `\n\n#action/missing-action\n\nLater unmatched `',
      description: 'Visible references',
    }, new Date(2026, 9, 10, 9));
    const check = validate(dir).checks.find(check => check.name === 'Inline mentions reference existing entities');
    expect(check).toMatchObject({passed: false, details: expect.arrayContaining([
      expect.stringContaining('references missing project #project/missing-project'),
      expect.stringContaining('references missing action #action/missing-action'),
    ])});
    expect(check!.details).toHaveLength(2);
  });

  it('validates explicit tags separately without treating metadata examples as inline prose', () => {
    const captured = handleCapture(store, {
      content: '`#project/code-example` and `#action/code-example`', description: 'Literal examples',
    }, new Date(2026, 9, 10, 9));
    const file = store.getEntryFile(captured.entryId)!;
    writeFileSync(file, readFileSync(file, 'utf8').replace(`created: ${captured.entryId}`, [
      `created: ${captured.entryId}`,
      'projects: [missing-project-tag]',
      'actions: [missing-action-tag]',
      'custom_example: "#project/metadata-example #action/metadata-example"',
    ].join('\n')));
    const checks = validate(dir).checks;
    expect(checks.find(check => check.name === 'Inline mentions reference existing entities')).toMatchObject({passed: true, details: []});
    expect(checks.find(check => check.name === 'Referenced projects have files')).toMatchObject({passed: false, details: [
      expect.stringContaining(`#entry/${captured.entryId} references missing project missing-project-tag`),
    ]});
    expect(checks.find(check => check.name === 'Referenced actions have files')).toMatchObject({passed: false, details: [
      expect.stringContaining(`#entry/${captured.entryId} references missing action missing-action-tag`),
    ]});
  });
});

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {init} from '../src/source/bootstrap.js';
import {Store} from '../src/source/store.js';
import {createArtifact} from '../src/mcp/tools/artifact.js';
import {handleCapture} from '../src/mcp/tools/capture.js';
import {artifactHandle} from '../src/core/artifact-reference.js';
import {projectionId} from '../src/core/recurrence.js';
import {executeGraphQL} from '../src/graphql/schema.js';

describe('links on lazily resolved action projections', () => {
  let root: string, store: Store, artifact: string, template: string;
  const fields = `id links { totalCount nodes { handle } }
    attachmentLinks { totalCount nodes { handle filename } }`;
  const query = async (document: string) => {
    const result = await executeGraphQL(store, 'query', {document});
    expect(result.errors).toBeUndefined();
    return result.data as any;
  };
  const warm = () => `warm: artifact(id: "${artifact}") {
    links { totalCount }
    backlinks { nodes { handle } }
    attachments { backlinks { nodes { handle } } }
  }`;
  const expectLinks = (node: any) => {
    expect(node.links).toEqual({totalCount: 1, nodes: [{handle: artifactHandle(artifact)}]});
    expect(node.attachmentLinks).toEqual({totalCount: 1, nodes: [
      {handle: artifactHandle(artifact, 'notes v2.md'), filename: 'notes v2.md'},
    ]});
  };

  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    vi.spyOn(Store.prototype, 'watch').mockImplementation(() => {});
    root = mkdtempSync('/private/tmp/aside-projection-links-');
    init(root, {name: 'Projection links', description: 'Fixture'});
    store = new Store(root);
    const file = join(root, 'notes v2.md');
    writeFileSync(file, 'Instructions');
    artifact = createArtifact(store, {name: 'Instructions', description: 'Context', body: 'Instructions', files: [{source: file}]}).id;
    template = handleCapture(store, {content: 'Define a routine.', description: 'Routine context', actions: [
      {name: 'Review', description: 'Review',
        body: `${artifactHandle(artifact)}\n[Notes](${artifactHandle(artifact, 'notes v2.md')})`,
        recurrence: [{dtstart: '2026-01-01', rrule: 'FREQ=DAILY'}]},
    ]}).createdActionIds[0];
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(root, {recursive: true, force: true});
  });

  it('keeps list projection links independent of sibling field order', async () => {
    const list = `actions(where: {scheduledFrom: "2026-01-01", scheduledTo: "2026-01-02", occurrence: {projected: true}}) {
      nodes { ${fields} }
    }`;
    const before = await query(`{ ${warm()} ${list} }`);
    const after = await query(`{ ${list} ${warm()} }`);
    expect(before.actions).toEqual(after.actions);
    expect(before.actions.nodes).toHaveLength(2);
    for (const node of before.actions.nodes) expectLinks(node);
  });

  it('keeps exact future projection links independent of sibling field order', async () => {
    const id = projectionId({template, original: '2030-01-01'});
    const exact = `action(id: "${id}") { ${fields} }`;
    const before = await query(`{ ${warm()} ${exact} }`);
    const after = await query(`{ ${exact} ${warm()} }`);
    expect(before.action).toEqual(after.action);
    expect(before.action.id).toBe(id);
    expectLinks(before.action);
  });

  it('keeps projected sources out of persistent record and attachment backlinks', async () => {
    const data = await query(`{
      action(id: "${projectionId({template, original: '2030-01-01'})}") { ${fields} }
      ${warm()}
    }`);
    expectLinks(data.action);
    expect(data.warm.backlinks.nodes).toEqual([{handle: `#action/${template}`}]);
    expect(data.warm.attachments[0].backlinks.nodes).toEqual([{handle: `#action/${template}`}]);
  });
});

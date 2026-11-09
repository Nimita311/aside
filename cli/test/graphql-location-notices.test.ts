import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {mkdtempSync, rmSync} from 'node:fs';
import {init} from '../src/source/bootstrap.js';
import {Store} from '../src/source/store.js';
import {handleCapture} from '../src/mcp/tools/capture.js';
import {createArtifact} from '../src/mcp/tools/artifact.js';
import {handleUpdateEntry} from '../src/mcp/tools/update.js';
import type {GraphQLResult} from '../src/graphql/schema.js';
import {executeGraphQLWithOwner as executeGraphQL, type MutationRunner} from './graphql-owner-fixture.js';
import {hasGraphQLProblems} from '../src/graphql/results.js';
import * as locations from '../src/core/location-reference.js';

const postal = '#location/?postal=10%20Downing%20Street/London/SW1A%202AA/United%20Kingdom/';
const combined = '#location/?geo=51.5034,-0.1276&postal=10%20Downing%20Street/London/SW1A%202AA/United%20Kingdom/';

describe('nonfatal postal-only location write notices', () => {
  let directory: string;
  let store: Store;
  let nextMinute: number;
  const geocodeAddress = vi.fn();
  const mutate: MutationRunner = (operation, input) => {
    if (operation === 'capture') return handleCapture(store, input as Parameters<typeof handleCapture>[1], new Date(2026, 9, 31, 9, nextMinute++));
    if (operation === 'update_entry') return handleUpdateEntry(store, input as Parameters<typeof handleUpdateEntry>[1]);
    if (operation === 'create_artifact') return createArtifact(store, input as Parameters<typeof createArtifact>[1], new Date(2026, 9, 31, 8));
    throw new Error(`Unexpected test mutation: ${operation}`);
  };
  const capture = (content: string) => executeGraphQL(store, 'mutation', {
    document: 'mutation($content:String!) { capture(input:{content:$content, description:"Location note"}) {entry{id}} }',
    variables: {content},
  }, {mutate, geocodeAddress});
  const entry = (id: string, source = store) => source.getEntries().find(value => value.meta.created === id)!;
  const receipt = (result: GraphQLResult) => {
    expect(result.errors).toBeUndefined();
    expect(result.extensions).toMatchObject({complete: true, diagnostics: []});
    expect(hasGraphQLProblems(result)).toBe(false);
    const value = (result.extensions!.mutations as any[])[0];
    expect(value.error).toBeNull();
    return value;
  };

  beforeEach(() => {
    directory = mkdtempSync('/tmp/aside-location-notices-');
    init(directory, {name: 'Location notices', description: 'Postal-only write receipt fixture'});
    store = new Store(directory);
    nextMinute = 0;
    geocodeAddress.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    store?.close();
    rmSync(directory, {recursive: true, force: true});
  });

  it('saves postal-only content and returns an advisory even when the payload omits notices and error', async () => {
    const result = await capture(`Meet at ${postal}.`);
    const id = (result.data!.capture as any).entry.id;
    const value = receipt(result);
    expect(value.changes).toEqual(expect.arrayContaining([expect.objectContaining({kind: 'entry', id, effect: 'CREATED'})]));
    expect(value.notices).toEqual([{code: 'location_geo_missing', recordHandle: `#entry/${id}`, handle: postal,
      message: expect.stringContaining('geocodeAddress whenever possible')}]);
    expect(entry(id).content).toBe(`Meet at ${postal}.`);
    expect(geocodeAddress).not.toHaveBeenCalled();
    const reloaded = new Store(directory);
    try { expect(entry(id, reloaded).content).toBe(`Meet at ${postal}.`); }
    finally { reloaded.close(); }

    const query = await executeGraphQL(store, 'query', {document: 'query($id:ID!){entry(id:$id){content}}', variables: {id}});
    expect(query.errors).toBeUndefined();
    expect(query.extensions).toMatchObject({complete: true, diagnostics: [], mutations: []});
    expect(store.getIssues()).toEqual([]);
  });

  it('deduplicates the same saved record and handle, ignoring code, escaped text and Markdown display labels', async () => {
    const other = '#location/?postal=1%20Main%20Street/Springfield/US/';
    const literal = '#location/?postal=Literal%20Address/US/';
    const content = [postal, postal, `[Office](${postal})`, `[Other office][other]`,
      '`' + literal + '`', '\\' + literal, `[${literal}](https://example.com)`,
      '```text\n' + literal + '\n```', `[${literal}][outside]`,
      `[other]: ${other}\n[outside]: https://example.com\n[unused]: ${literal}`].join('\n\n');
    const value = receipt(await capture(content));
    expect(value.notices.map((notice: any) => notice.handle)).toEqual([postal, other]);
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it('omits advisory fields for geocoded mentions and literal postal examples', async () => {
    const content = [combined, '#location/?geo=51.5034,-0.1276', '`' + postal + '`',
      '\\' + postal, `[${postal}](https://example.com)`].join(' ');
    const value = receipt(await capture(content));
    expect(value).not.toHaveProperty('notices');
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it('lets the agent enrich a saved mention with an ordinary update and then stops reporting it', async () => {
    const captured = await capture(postal);
    const id = (captured.data!.capture as any).entry.id;
    const update = (content: string) => executeGraphQL(store, 'mutation', {
      document: 'mutation($id:ID!,$content:String!){updateEntry(id:$id,input:{content:$content}){error entry{id content}}}',
      variables: {id, content},
    }, {mutate, geocodeAddress});
    expect(receipt(await update(postal)).notices).toHaveLength(1);
    const enriched = await update(combined);
    expect(receipt(enriched)).not.toHaveProperty('notices');
    expect((enriched.data!.updateEntry as any).entry.content).toBe(combined);
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it('identifies linked project/action bodies and artifact bodies without changing the entry', async () => {
    const linked = await executeGraphQL(store, 'mutation', {
      document: `mutation($body:String!){capture(input:{content:"Meeting context",description:"Linked locations",
        projects:[{create:{name:"Venue",description:"Venue",body:$body}}],
        actions:[{create:{name:"Visit",description:"Visit",body:$body}}]}){
          entry{id} createdProjects{id} createdActions{id}
        }}`,
      variables: {body: postal},
    }, {mutate, geocodeAddress});
    const payload = linked.data!.capture as any;
    expect(receipt(linked).notices.map((notice: any) => notice.recordHandle).sort()).toEqual([
      `#project/${payload.createdProjects[0].id}`, `#action/${payload.createdActions[0].id}`,
    ].sort());

    const artifact = await executeGraphQL(store, 'mutation', {
      document: 'mutation($body:String!){createArtifact(input:{name:"Venue details",description:"Venue details",body:$body}){artifact{id}}}',
      variables: {body: postal},
    }, {mutate, geocodeAddress});
    expect(receipt(artifact).notices[0].recordHandle).toBe(`#artifact/${(artifact.data!.createArtifact as any).artifact.id}`);
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it('keeps confirmed write receipts intact if advisory extraction cannot complete', async () => {
    vi.spyOn(locations, 'extractLocationReferences').mockImplementationOnce(() => { throw new Error('Inspection unavailable'); });
    const result = await capture(postal);
    expect(receipt(result)).not.toHaveProperty('notices');
    expect(entry((result.data!.capture as any).entry.id).content).toBe(postal);
  });
});

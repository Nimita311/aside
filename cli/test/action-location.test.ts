import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { init } from '../src/source/bootstrap.js';
import { parseActionFile } from '../src/core/parser.js';
import { validate } from '../src/core/validator.js';
import { projectionId, resolveProjection } from '../src/core/recurrence.js';
import { actionProjections } from '../src/core/action-projections.js';
import { Store } from '../src/source/store.js';
import { TOOL_SCHEMAS } from '../src/mcp/schemas.js';
import { handleCapture, type NewAction } from '../src/mcp/tools/capture.js';
import { handleUpdateAction } from '../src/mcp/tools/update.js';
import { handleUpdateOccurrence } from '../src/mcp/tools/recurrence.js';
import { serializeAction } from '../src/source/serialize.js';
import { normalizeMutationArguments } from '../src/graphql/inputs.js';
import {executeGraphQLWithOwner as executeGraphQL, type MutationRunner, outcome} from './graphql-owner-fixture.js';

const geo = '#location/?geo=51.503400,-0.127600;crs=wgs84;u=4';
const other = '#location/?geo=37.7955,-122.3937';
const postal = '#location/?postal=10%20Downing%20Street/London/UK/';
const both = `${geo}&postal=10%20Downing%20Street/London/UK/`;
const now = new Date(2026, 9, 30, 8);

describe('action location model and API', () => {
  let directory: string, store: Store, minute: number;
  beforeEach(() => {
    directory = mkdtempSync('/tmp/aside-action-location-');
    init(directory, { name: 'Action locations', description: 'Action location fixture' });
    store = new Store(directory); minute = 0;
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); vi.restoreAllMocks(); });

  const create = (location?: string, rest: Partial<NewAction> = {}) => handleCapture(store, {
    content: 'Visit the office', description: 'Visit', actions: [{ name: 'Visit', description: 'Visit', ...rest, ...(location === undefined ? {} : { location }) }],
  }, now).createdActionIds[0];
  const run: MutationRunner = (operation, input) => {
    if (operation === 'capture') return handleCapture(store, input as Parameters<typeof handleCapture>[1], new Date(2026, 9, 30, 8, minute++));
    if (operation === 'update_action') return outcome(handleUpdateAction(store, input as Parameters<typeof handleUpdateAction>[1]), input.id as string);
    if (operation === 'update_occurrence') return handleUpdateOccurrence(store, input as Parameters<typeof handleUpdateOccurrence>[1], now);
    throw new Error(`Unexpected mutation: ${operation}`);
  };

  it('round-trips exact authored handles and omits an absent location', () => {
    const id = create(both), action = store.getAction(id)!;
    expect(action.frontMatter.location).toBe(both);
    expect(parseActionFile(readFileSync(store.getActionFile(id)!, 'utf8')).value.frontMatter.location).toBe(both);
    expect(parseActionFile(serializeAction(action.frontMatter, 'Body')).value.frontMatter.location).toBe(both);
    expect(parseActionFile(serializeAction({ name: 'No venue', created: '2026-10-30T08:00' }, '')).value.frontMatter).not.toHaveProperty('location');
    handleUpdateAction(store, { id, name: 'Visit later' });
    expect(store.getAction(id)!.frontMatter.location).toBe(both);
    handleUpdateAction(store, { id, location: other });
    expect(store.getAction(id)!.frontMatter.location).toBe(other);
    handleUpdateAction(store, { id, location: null });
    expect(store.getAction(id)!.frontMatter).not.toHaveProperty('location');
    expect(readFileSync(store.getActionFile(id)!, 'utf8')).not.toMatch(/^location:/m);
  });

  it.each([null, '', ' ', '10 Downing Street', `[Office](${geo})`, 'geo:51.5,-0.1', '#location/?geo=91,0', `${geo}&unknown=x`])(
    'rejects invalid or null create locations before any linked writes: %j', location => {
      expect(() => handleCapture(store, { content: 'Note', description: 'Note', projects: [{ name: 'Project', description: 'Project' }],
        actions: [{ name: 'Visit', description: 'Visit', location } as NewAction] }, now)).toThrow(/location/);
      expect(store.getActionIds()).toEqual([]);
      expect(store.getProjectIds()).toEqual([]);
      expect(store.getEntries()).toEqual([]);
    },
  );

  it.each(['', ' ', 'Address', `[Office](${geo})`, '#location/?geo=0,181'])('rejects invalid update locations without changing the saved record: %j', location => {
    const id = create(geo), file = store.getActionFile(id)!, before = readFileSync(file, 'utf8');
    expect(() => handleUpdateAction(store, { id, name: 'Changed', location })).toThrow(/location/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(store.getAction(id)!.frontMatter.location).toBe(geo);
  });

  it('preserves custom YAML, comments and aliases while setting and clearing the managed key', () => {
    const id = create(other), file = store.getActionFile(id)!;
    const original = readFileSync(file, 'utf8').replace(/^location:.*$/m,
      `location: &venue '${other}' # retained venue\ncustomVenue: *venue\ncustom:\n  nested: true`);
    writeFileSync(file, original); store.rebuild();
    handleUpdateAction(store, { id, body: 'Changed body' });
    expect(readFileSync(file, 'utf8')).toContain(`location: &venue '${other}' # retained venue`);
    handleUpdateAction(store, { id, location: null });
    const metadata = parse(readFileSync(file, 'utf8').split('---')[1]);
    expect(metadata).not.toHaveProperty('location');
    expect(metadata.customVenue).toBe(other);
    expect(metadata.custom).toEqual({ nested: true });
  });

  it.each([null, 42, { venue: 'custom' }, '#location/?geo=91,0'])('retains invalid authored location for repair and reports it without erasing unrelated YAML: %j', location => {
    const id = create(), file = store.getActionFile(id)!;
    writeFileSync(file, `---\nname: Visit\ncreated: 2026-10-30T08:00\n${stringify({ location, extension: { retained: true } })}---\n\nBody\n`);
    store.rebuild();
    expect(store.getAction(id)!.frontMatter.location).toEqual(location);
    expect(store.getIssues()).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid_location', field: 'location', severity: 'error' })]));
    expect(validate(directory).checks.find(check => check.name === 'Action locations are valid location handles')?.passed).toBe(false);
    const before = readFileSync(file, 'utf8').split('---')[1];
    expect(() => handleUpdateAction(store, { id, body: 'Edited without replacing metadata' })).not.toThrow();
    expect(readFileSync(file, 'utf8').split('---')[1]).toBe(before);
    handleUpdateAction(store, { id, location: geo });
    expect(store.getAction(id)!.frontMatter.location).toBe(geo);
    expect(parse(readFileSync(file, 'utf8').split('---')[1]).extension).toEqual({ retained: true });
    store.rebuild(); // Diagnostics describe the last disk rebuild, matching other authored-field repairs.
    expect(store.getIssues().some(issue => issue.code === 'invalid_location')).toBe(false);
  });

  it('inherits template locations into projections and snapshots, while occurrence overrides and clears remain independent', () => {
    const template = create(geo, { recurrence: [{ dtstart: '2026-10-30T09:00', rrule: 'FREQ=DAILY;COUNT=5' }] });
    const projected = actionProjections(store.getActions(), { from: '2026-10-31', to: '2026-11-02' });
    expect(projected.nodes.length).toBeGreaterThan(0);
    expect(projected.nodes.every(node => node.action.frontMatter.location === geo)).toBe(true);
    const inherited = handleUpdateOccurrence(store, { template, original: '2026-10-31T09:00', body: 'Materialized' }, now).id;
    const overridden = handleUpdateOccurrence(store, { template, original: '2026-11-01T09:00', location: other }, now).id;
    const cleared = handleUpdateOccurrence(store, { template, original: '2026-11-02T09:00', location: null }, now).id;
    expect(store.getAction(inherited)!.frontMatter.location).toBe(geo);
    expect(store.getAction(overridden)!.frontMatter.location).toBe(other);
    expect(store.getAction(cleared)!.frontMatter).not.toHaveProperty('location');
    handleUpdateAction(store, { id: template, location: both });
    expect(store.getAction(inherited)!.frontMatter.location).toBe(geo);
    expect(store.getAction(overridden)!.frontMatter.location).toBe(other);
    expect(store.getAction(cleared)!.frontMatter).not.toHaveProperty('location');
    expect(resolveProjection(store.getActions(), projectionId({ template, original: '2026-11-03T09:00' }))!.frontMatter.location).toBe(both);
    handleUpdateOccurrence(store, { template, original: '2026-11-01T09:00', location: null }, now);
    expect(store.getAction(overridden)!.frontMatter).not.toHaveProperty('location');
  });

  it('applies the same bare-handle and null contract in operation schemas and GraphQL normalization', () => {
    const action = { name: 'Visit', description: 'Visit', location: postal };
    expect(TOOL_SCHEMAS.capture.safeParse({ content: 'Note', description: 'Note', actions: [action] }).success).toBe(true);
    expect(TOOL_SCHEMAS.capture.safeParse({ content: 'Note', description: 'Note', actions: [{ ...action, location: null }] }).success).toBe(false);
    expect(TOOL_SCHEMAS.update_action.safeParse({ id: 'id', location: null }).success).toBe(true);
    expect(TOOL_SCHEMAS.update_occurrence.safeParse({ template: 'id', original: '2026-10-31T09:00', location: null }).success).toBe(true);
    expect(normalizeMutationArguments('capture', { input: { content: 'Note', description: 'Note', actions: [{ create: action }] } }).input.actions[0].location).toBe(postal);
    expect(normalizeMutationArguments('updateAction', { id: 'id', input: { location: null } }).input.location).toBeNull();
    expect(() => normalizeMutationArguments('capture', { input: { content: 'Note', description: 'Note', actions: [{ create: { ...action, location: null } }] } })).toThrow();
  });

  it('exposes action locations in GraphQL and gives postal-only metadata a nonfatal notice without geocoding', async () => {
    const geocodeAddress = vi.fn();
    const created = await executeGraphQL(store, 'mutation', {
      document: 'mutation($location:String!){capture(input:{content:"Meeting",description:"Meeting",actions:[{create:{name:"Visit",description:"Visit",location:$location}}]}){error createdActions{id location body}}}',
      variables: { location: postal },
    }, { mutate: run, geocodeAddress });
    expect(created.errors).toBeUndefined();
    const action = (created.data!.capture as any).createdActions[0];
    expect(action.location).toBe(postal);
    expect(created.extensions).toMatchObject({ complete: true, diagnostics: [] });
    expect((created.extensions!.mutations as any[])[0]).toMatchObject({ error: null, notices: [{ code: 'location_geo_missing', recordHandle: `#action/${action.id}`, handle: postal }] });
    const cleared = await executeGraphQL(store, 'mutation', {
      document: 'mutation($id:ID!){updateAction(id:$id,input:{location:null}){error action{id location}}}', variables: { id: action.id },
    }, { mutate: run, geocodeAddress });
    expect(cleared.errors).toBeUndefined();
    expect((cleared.data!.updateAction as any).action.location).toBeNull();
    expect((cleared.extensions!.mutations as any[])[0]).not.toHaveProperty('notices');
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it('rejects GraphQL invalid locations before invoking a write handler', async () => {
    const mutate = vi.fn();
    const result = await executeGraphQL(store, 'mutation', {
      document: 'mutation{capture(input:{content:"Note",description:"Note",actions:[{create:{name:"Visit",description:"Visit",location:null}}]}){entry{id}}}',
    }, { mutate });
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(mutate).not.toHaveBeenCalled();
    expect(store.getActionIds()).toEqual([]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeGraphQL, prepareGraphQL } from '../src/graphql/schema.js';
import type { GeocodeAddressInput, GeocodeAddressResult } from '../src/mcp/geocoding.js';
import * as geocoding from '../src/mcp/geocoding.js';
import { InstanceHost } from '../src/daemon/host.js';
import { InstanceRegistry } from '../src/mcp/instance-registry.js';
import { InstanceSession } from '../src/mcp/instance-session.js';
import { CalClient } from '../src/mcp/calendar/client.js';
import { prepareWebQuery } from '../src/web/query.js';

const noRecords = () => { throw new Error('Address lookup must not load or write records.'); };
const document = `query Address($input: GeocodeAddressInput!) {
  geocodeAddress(input: $input) {
    status provider error
    candidates { geo latitude longitude formattedAddress name countryCode mapUrl }
  }
}`;
const candidate = {
  geo: 'geo:51.5034,-0.1276', latitude: 51.5034, longitude: -0.1276,
  formattedAddress: '10 Downing Street, London SW1A 2AA, United Kingdom',
  name: '10 Downing Street', countryCode: 'GB',
  mapUrl: 'https://maps.apple.com/place?coordinate=51.5034%2C-0.1276',
};
const success = (candidates = [candidate]): GeocodeAddressResult => ({status: 'SUCCESS', provider: 'APPLE', candidates, error: null});

describe('agent geocoding API', () => {
  afterEach(() => vi.restoreAllMocks());

  it('connects the daemon agent surface without selecting or loading an instance', async () => {
    const lookup = vi.spyOn(geocoding, 'geocodeAddress').mockResolvedValue(success());
    const host = new InstanceHost(new CalClient(null));
    const load = vi.spyOn(host as any, 'load');
    const session = new InstanceSession(new InstanceRegistry([]), {knownInstances: async () => [], issues: async () => []});
    try {
      const response = await host.graphql(session, 'query', {document, variables: {input: {query: 'Address'}}});
      expect(response.errors).toBeUndefined();
      expect(response.data!.geocodeAddress).toEqual(success());
      expect(lookup).toHaveBeenCalledOnce();
      expect(load).not.toHaveBeenCalled();
      expect(session.registry.activeInstance).toBeNull();
    } finally { await host.close(); }
  });

  it('lets an unselected agent inspect candidates and retry refined inputs without writing', async () => {
    const geocodeAddress = vi.fn()
      .mockResolvedValueOnce(success([candidate, {...candidate, geo: 'geo:40,-74', latitude: 40, longitude: -74, countryCode: 'US'}]))
      .mockResolvedValueOnce(success());
    const mutate = vi.fn(() => { throw new Error('No writes allowed'); });
    const first = await executeGraphQL(noRecords, 'query', {document, variables: {input: {query: '10 Downing Street'}}}, {geocodeAddress, mutate});
    expect(first.errors).toBeUndefined();
    expect((first.data!.geocodeAddress as any).candidates).toHaveLength(2);
    expect(first.extensions).toMatchObject({complete: true, mutations: []});
    const region = {latitude: 51.5, longitude: -0.12, radiusMeters: 5000};
    const refined = await executeGraphQL(noRecords, 'query', {document, variables: {
      input: {query: ' 10 Downing Street, London SW1A 2AA, UK ', region},
    }}, {geocodeAddress, mutate});
    expect(refined.errors).toBeUndefined();
    expect(refined.data!.geocodeAddress).toEqual(success());
    expect(geocodeAddress.mock.calls[1][0]).toEqual({query: '10 Downing Street, London SW1A 2AA, UK', region});
    expect(geocodeAddress.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('accepts business names and street addresses through the same query argument', async () => {
    const geocodeAddress = vi.fn(async (_input: GeocodeAddressInput) => success());
    const mutate = vi.fn();
    for (const input of [{query:'Tartine Bakery, San Francisco'}, {query:'600 Guerrero St, San Francisco'}]) {
      const result = await executeGraphQL(noRecords, 'query', {document,variables:{input:{...input,
        region:{latitude:37.76,longitude:-122.42,radiusMeters:5000}}}}, {geocodeAddress,mutate});
      expect(result.errors).toBeUndefined();
      expect(result.extensions).toMatchObject({complete:true,mutations:[]});
      expect(geocodeAddress.mock.calls.at(-1)?.[0]).toMatchObject(input);
    }
    expect(mutate).not.toHaveBeenCalled();
    const unknown = await executeGraphQL(noRecords, 'query', {document,variables:{input:{query:'Tartine',mode:'PLACE'}}}, {geocodeAddress});
    expect(unknown.errors?.length).toBeGreaterThan(0);
    expect(geocodeAddress).toHaveBeenCalledTimes(2);
  });

  it.each(['FAILED', 'UNAVAILABLE'] as const)('returns %s with recovery data and incomplete diagnostics', async status => {
    const geocodeAddress = vi.fn(async (): Promise<GeocodeAddressResult> => ({status, provider: 'APPLE', candidates: [], error: 'Retry the lookup after recovery.'}));
    const result = await executeGraphQL(noRecords, 'query', {document, variables: {input: {query: 'An address'}}}, {geocodeAddress});
    expect(result.errors).toBeUndefined();
    expect(result.data!.geocodeAddress).toMatchObject({status, candidates: [], error: 'Retry the lookup after recovery.'});
    expect(result.extensions).toMatchObject({complete: false, diagnostics: [{code: `geocoding_${status.toLowerCase()}`}], mutations: []});
  });

  it('distinguishes a successful empty lookup from an unavailable geocoder', async () => {
    const args = {document, variables: {input: {query: 'Unmatched address'}}};
    const empty = await executeGraphQL(noRecords, 'query', args, {geocodeAddress: async () => ({status: 'NO_RESULTS', provider: 'APPLE', candidates: [], error: null})});
    expect(empty.errors).toBeUndefined();
    expect(empty.data!.geocodeAddress).toMatchObject({status: 'NO_RESULTS', candidates: [], error: null});
    expect(empty.extensions).toMatchObject({complete: true});
    const unavailable = await executeGraphQL(noRecords, 'query', args);
    expect(unavailable.data!.geocodeAddress).toMatchObject({status: 'UNAVAILABLE', candidates: []});
    expect(unavailable.extensions).toMatchObject({complete: false});
  });

  it.each([
    {}, {query:null}, {query:'   '},
    {address:'Address'}, {place:'Venue'}, {query:'Address',address:null}, {query:'Venue',place:null},
    {query:'Address',locale:'en-US'}, {query:'Address',mode:'AUTO'},
    {query: 'Address', region: {latitude: 91, longitude: 0, radiusMeters: 10}},
    {query: 'Address', region: {latitude: 0, longitude: 181, radiusMeters: 10}},
    {query: 'Address', region: {latitude: 0, longitude: 0, radiusMeters: 0}},
    {query: 'Address', region: {latitude: 0, longitude: 0, radiusMeters: 20000001}},
  ])('rejects invalid input before the native lookup: %j', async input => {
    const geocodeAddress = vi.fn();
    const result = await executeGraphQL(noRecords, 'query', {document, variables: {input}}, {geocodeAddress});
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it('does not start a cancelled lookup and forwards in-flight cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    const geocodeAddress = vi.fn();
    const args = {document, variables: {input: {query: 'Address'}}};
    const result = await executeGraphQL(noRecords, 'query', args, {signal: controller.signal, geocodeAddress});
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(geocodeAddress).not.toHaveBeenCalled();
    const active = new AbortController();
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    const pending = executeGraphQL(noRecords, 'query', args, {signal: active.signal,
      geocodeAddress: (_input, {signal}) => new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), {once: true});
        began();
      }),
    });
    await started;
    active.abort();
    expect((await pending).errors?.length).toBeGreaterThan(0);
  });

  it('exposes only read-only lookup and blocks webpage access and excessive fan-out', async () => {
    expect(prepareGraphQL('query', {document, variables: {input: {query: 'Address'}}}).errors).toBeUndefined();
    expect(prepareGraphQL('mutation', {document: 'mutation { geocodeAddress(input:{query:"Address"}) {status} }'}).errors).toBeDefined();
    expect('result' in prepareWebQuery({query: '{ geocodeAddress(input:{query:"Address"}) {status} }'})).toBe(true);
    const geocodeAddress = vi.fn();
    const result = await executeGraphQL(noRecords, 'query', {document: `{${Array.from({length: 6}, (_, i) => `a${i}: geocodeAddress(input:{query:"Address"}) {status}`).join(' ')}}`}, {geocodeAddress});
    expect(JSON.stringify(result.errors)).toContain('At most five');
    expect(geocodeAddress).not.toHaveBeenCalled();
  });
});

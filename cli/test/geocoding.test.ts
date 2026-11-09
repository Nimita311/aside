import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGeocoder, normalizeGeocodeAddressInput, type GeocodeAddressInput } from '../src/mcp/geocoding.js';
import { GEOCODING_QUEUE_LIMIT } from '../src/core/system-config.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function fixture(body: string, timeoutMs = 2_000) {
  const directory = mkdtempSync('/tmp/aside-geocode-');
  directories.push(directory);
  const binPath = join(directory, 'helper.cjs');
  writeFileSync(binPath, `#!/usr/bin/env node\nlet input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => input += value); process.stdin.on('end', () => { const request = JSON.parse(input); ${body} });\n`);
  chmodSync(binPath, 0o755);
  return { directory, binPath, geocode: createGeocoder({ binPath, platform: 'darwin', release: '23.0.0', timeoutMs }) };
}

const emit = (response: unknown) => `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`;

describe('native address geocoding adapter', () => {
  it('dispatches the unified helper with geocode and keeps legacy stand-ins argument-free', async () => {
    const { directory, binPath } = fixture(`require('fs').writeFileSync(require('path').join(__dirname,'argv.json'), JSON.stringify(process.argv.slice(2))); ${emit({ status: 'NO_RESULTS', candidates: [] })}`);
    vi.stubEnv('ASIDE_GEO_BIN', '');
    vi.stubEnv('ASIDE_NATIVE_BIN', binPath);
    const native = createGeocoder({ platform: 'darwin', release: '23.0.0' });
    expect((await native({ query: 'Place' })).status).toBe('NO_RESULTS');
    expect(JSON.parse(readFileSync(join(directory, 'argv.json'), 'utf8'))).toEqual(['geocode']);
    vi.stubEnv('ASIDE_GEO_BIN', binPath);
    expect((await native({ query: 'Place' })).status).toBe('NO_RESULTS');
    expect(JSON.parse(readFileSync(join(directory, 'argv.json'), 'utf8'))).toEqual([]);
    vi.stubEnv('ASIDE_GEO_BIN', '/fixtures/missing');
    const explicit = createGeocoder({ binPath, platform: 'darwin', release: '23.0.0' });
    expect((await explicit({ query: 'Place' })).status).toBe('NO_RESULTS');
    expect(JSON.parse(readFileSync(join(directory, 'argv.json'), 'utf8'))).toEqual([]);
  });

  it('passes normalized hints, preserves provider order, and produces pasteable geo URIs and encoded map links', async () => {
    const { directory, geocode } = fixture(`require('fs').writeFileSync(require('path').join(__dirname,'request.json'),JSON.stringify(request)); process.stdout.write(JSON.stringify({ status: 'SUCCESS', candidates: [
      { latitude: 37.7955, longitude: -122.3937, formattedAddress: request.query, name: 'Ferry Building', countryCode: 'US' },
      { latitude: 1e-7, longitude: -0 }
    ], received: request }));`);
    const value = await geocode({ query: '  1 Ferry Building & Market  ', region: { latitude: 37, longitude: -122, radiusMeters: 1000 } });
    expect(value).toMatchObject({ status: 'SUCCESS', provider: 'APPLE', error: null });
    expect(value.candidates[0]).toMatchObject({ geo: 'geo:37.7955,-122.3937', latitude: 37.7955, longitude: -122.3937, formattedAddress: '1 Ferry Building & Market', name: 'Ferry Building', countryCode: 'US' });
    const map = new URL(value.candidates[0].mapUrl);
    expect(map.origin + map.pathname).toBe('https://maps.apple.com/place');
    expect(map.searchParams.get('coordinate')).toBe('37.7955,-122.3937');
    expect(map.searchParams.get('address')).toBe('1 Ferry Building & Market');
    expect(map.searchParams.get('name')).toBe('Ferry Building');
    expect(value.candidates[1]).toMatchObject({ geo: 'geo:0.0000001,0', formattedAddress: null, name: null, countryCode: null });
    expect(JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'))).toEqual({ query: '1 Ferry Building & Market', region: { latitude: 37, longitude: -122, radiusMeters: 1000 } });
  });

  it('forwards a fresh region snapshot and omits empty optional hints', () => {
    const input = { query: ' Ferry Building ', region: { latitude: 37, longitude: -122, radiusMeters: 1000 } };
    const normalized = normalizeGeocodeAddressInput(input);
    input.region.latitude = 0;
    expect(normalized).toEqual({ query: 'Ferry Building', region: { latitude: 37, longitude: -122, radiusMeters: 1000 } });
    expect(normalizeGeocodeAddressInput({ query: 'Place', region: null })).toEqual({ query: 'Place' });
    expect(normalizeGeocodeAddressInput({ query: '  Café 東京  ' })).toEqual({ query: 'Café 東京' });
  });

  it('forwards query lookups without interpreting or selecting candidates', async () => {
    const { directory, geocode } = fixture(`require('fs').writeFileSync(require('path').join(__dirname,'request.json'),JSON.stringify(request)); ${emit({status:'SUCCESS', candidates:[
      {latitude:37.7614,longitude:-122.4241,name:'Tartine Bakery',formattedAddress:'600 Guerrero St, San Francisco, CA'},
      {latitude:37.764,longitude:-122.419,name:'Tartine Manufactory',formattedAddress:'595 Alabama St, San Francisco, CA'},
    ]})}`);
    const region = {latitude:37.76,longitude:-122.42,radiusMeters:5000};
    const response = await geocode({query:'  Tartine, San Francisco  ', region});
    expect(JSON.parse(readFileSync(join(directory, 'request.json'), 'utf8'))).toEqual({query:'Tartine, San Francisco',region});
    expect(response.status).toBe('SUCCESS');
    expect(response.candidates.map(candidate => candidate.name)).toEqual(['Tartine Bakery','Tartine Manufactory']);
    expect(response.candidates[0].geo).toBe('geo:37.7614,-122.4241');
    expect(new URL(response.candidates[0].mapUrl).searchParams.get('name')).toBe('Tartine Bakery');
  });

  it.each([
    {}, {query:null}, {query:undefined}, [], null,
    {address:'Address'}, {place:'Venue'}, {query:'Address',address:null}, {query:'Venue',place:null},
    {query:'Address',mode:'PLACE'}, {query:'Venue',locale:'en-US'},
    { query: '' }, { query: ' \n ' }, { query: 'x'.repeat(4097) }, { query: 42 }, { query: 'Place\0' },
    ...[
      { latitude: 91, longitude: 0, radiusMeters: 10 }, { latitude: 0, longitude: -181, radiusMeters: 10 },
      { latitude: NaN, longitude: 0, radiusMeters: 10 }, { latitude: 0, longitude: Infinity, radiusMeters: 10 },
      { latitude: 0, longitude: 0, radiusMeters: 0 }, { latitude: 0, longitude: 0, radiusMeters: -1 },
      { latitude: 0, longitude: 0, radiusMeters: 20_000_001 }, { latitude: 0, longitude: 0, radiusMeters: Infinity },
    ].map(region => ({ query: 'Place', region })),
  ])('rejects invalid input before helper execution: %j', async input => {
    const geocode = createGeocoder({ binPath: null });
    await expect(geocode(input as GeocodeAddressInput)).rejects.toThrow(/Geocoding/);
  });

  it('keeps invalid-input diagnostics free of the raw address', async () => {
    const query = 'PRIVATE-ADDRESS'.repeat(400);
    const error = await createGeocoder()({ query }).catch(error => error as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('PRIVATE-ADDRESS');
  });

  it('reports unsupported systems and absent helpers without lookup', async () => {
    expect(await createGeocoder({ platform: 'linux', release: '6.8.0' })({ query: 'Place' })).toMatchObject({ status: 'UNAVAILABLE', candidates: [], error: expect.stringContaining('macOS 14') });
    expect(await createGeocoder({ platform: 'darwin', release: '22.6.0' })({ query: 'Place' })).toMatchObject({ status: 'UNAVAILABLE' });
    expect(await createGeocoder({ platform: 'darwin', release: 'unknown' })({ query: 'Place' })).toMatchObject({ status: 'UNAVAILABLE' });
    expect(await createGeocoder({ platform: 'darwin', release: '23.0.0', binPath: null })({ query: 'Place' })).toMatchObject({ status: 'UNAVAILABLE', error: expect.stringContaining('not installed') });
  });

  it('reports a helper that cannot execute as unavailable', async () => {
    const { binPath } = fixture('');
    chmodSync(binPath, 0o644);
    const geocode = createGeocoder({ platform: 'darwin', release: '23.0.0', binPath });
    expect(await geocode({ query: 'Place' })).toMatchObject({ status: 'UNAVAILABLE', candidates: [], error: expect.stringContaining('could not start') });
  });

  it('distinguishes no results from a native failure without exposing native diagnostics', async () => {
    expect(await fixture(emit({ status: 'NO_RESULTS', candidates: [] })).geocode({ query: 'Place' })).toEqual({ status: 'NO_RESULTS', provider: 'APPLE', candidates: [], error: null });
    const failed = await fixture(`process.stderr.write(request.query); process.stdout.write(JSON.stringify({status:'FAILED', error:request.query}));`).geocode({ query: 'PRIVATE-ADDRESS' });
    expect(failed).toEqual({ status: 'FAILED', provider: 'APPLE', candidates: [], error: 'Apple geocoding failed. Retry later, or refine the query and region hint.' });
    const nativeError = 'Apple geocoding failed (kCLErrorDomain, code 2).';
    expect(await fixture(emit({ status: 'FAILED', error: nativeError })).geocode({ query: 'Place' })).toMatchObject({ error: expect.stringContaining(nativeError) });
  });

  it.each([
    null, { status: 'UNKNOWN' }, { status: 'SUCCESS', candidates: [] },
    { status: 'SUCCESS', candidates: [{ latitude: '37', longitude: -122 }] },
    { status: 'SUCCESS', candidates: [{ latitude: 91, longitude: -122 }] },
    { status: 'SUCCESS', candidates: [{ latitude: 37, longitude: -181 }] },
    { status: 'SUCCESS', candidates: [{ latitude: 37, longitude: -122, name: 10 }] },
    { status: 'SUCCESS', candidates: [{ latitude: 37, longitude: -122 }, { latitude: null, longitude: -122 }] },
    { status: 'NO_RESULTS', candidates: [{ latitude: 37, longitude: -122 }] },
  ])('rejects the complete malformed native response: %j', async response => {
    expect(await fixture(emit(response)).geocode({ query: 'Place' })).toMatchObject({ status: 'FAILED', candidates: [], error: expect.stringContaining('invalid response') });
  });

  it('rejects non-JSON output and unexpected exits', async () => {
    expect(await fixture(`process.stdout.write('not JSON');`).geocode({ query: 'Place' })).toMatchObject({ status: 'FAILED', error: expect.stringContaining('invalid response') });
    expect(await fixture('process.exit(7);').geocode({ query: 'Place' })).toMatchObject({ status: 'FAILED', error: expect.stringContaining('exited unexpectedly') });
  });

  it.each(['stdout', 'stderr'])('bounds %s from a noisy helper', async stream => {
    expect(await fixture(`process.${stream}.write('x'.repeat(2*1024*1024)); setInterval(() => {}, 1000);`).geocode({ query: 'Place' })).toMatchObject({ status: 'FAILED', error: expect.stringContaining('output limit') });
  });

  it('terminates a helper after the request timeout', async () => {
    expect(await fixture('setInterval(() => {}, 1000);', 50).geocode({ query: 'Place' })).toMatchObject({ status: 'FAILED', error: expect.stringContaining('timed out') });
  });

  it('serializes helper launches, cancels queued work without spawning, and continues after cancellation', async () => {
    const { directory, geocode } = fixture(`const fs=require('fs'), path=require('path').join(__dirname,'events'); fs.appendFileSync(path,'start:'+request.query+'\\n'); setTimeout(() => { fs.appendFileSync(path,'end:'+request.query+'\\n'); process.stdout.write(JSON.stringify({status:'NO_RESULTS',candidates:[]})); }, 40);`);
    const first = geocode({ query: 'first' });
    const controller = new AbortController();
    const second = geocode({ query: 'cancelled' }, { signal: controller.signal });
    const third = geocode({ query: 'third' });
    controller.abort();
    expect(await second).toMatchObject({ status: 'FAILED', error: expect.stringContaining('cancelled') });
    expect((await first).status).toBe('NO_RESULTS');
    expect((await third).status).toBe('NO_RESULTS');
    expect(readFileSync(join(directory, 'events'), 'utf8')).toBe('start:first\nend:first\nstart:third\nend:third\n');
  });

  it('cancels active work and skips already-aborted requests', async () => {
    const { geocode } = fixture('setInterval(() => {}, 1000);');
    const controller = new AbortController();
    const active = geocode({ query: 'Place' }, { signal: controller.signal });
    controller.abort();
    expect(await active).toMatchObject({ status: 'FAILED', error: expect.stringContaining('cancelled') });
    expect(await geocode({ query: 'Place' }, { signal: controller.signal })).toMatchObject({ status: 'FAILED', error: expect.stringContaining('cancelled') });
  });

  it('bounds the pending queue and releases cancelled slots', async () => {
    const { geocode } = fixture('setInterval(() => {}, 1000);');
    const activeController = new AbortController(), queuedController = new AbortController();
    const active = geocode({ query: 'active' }, { signal: activeController.signal });
    const queued = Array.from({ length: GEOCODING_QUEUE_LIMIT }, () => geocode({ query: 'queued' }, { signal: queuedController.signal }));
    expect(await geocode({ query: 'overflow' })).toMatchObject({ status: 'FAILED', error: expect.stringContaining('queue is full') });
    queuedController.abort();
    expect((await Promise.all(queued)).every(value => value.error?.includes('cancelled'))).toBe(true);
    const replacementController = new AbortController();
    const replacement = geocode({ query: 'replacement' }, { signal: replacementController.signal });
    replacementController.abort();
    expect(await replacement).toMatchObject({ error: expect.stringContaining('cancelled') });
    activeController.abort();
    expect(await active).toMatchObject({ error: expect.stringContaining('cancelled') });
  });
});

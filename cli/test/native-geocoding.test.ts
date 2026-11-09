import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

describe.skipIf(process.platform !== 'darwin')('native geocoding lookup policy', () => {
  let directory: string;
  let binary: string;
  let compatibilityArgs: string[];

  beforeAll(() => {
    directory = mkdtempSync('/tmp/aside-geocoding-native-');
    binary = join(directory, 'policy');
    const sdk = process.env.SDKROOT || execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {encoding: 'utf8'}).trim();
    const major = Number(execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :Version', join(sdk, 'SDKSettings.plist')], {encoding: 'utf8'}).trim().split('.')[0]);
    const source = fileURLToPath(new URL('../native/aside-native/Geocoding.swift', import.meta.url));
    const fixture = fileURLToPath(new URL('./fixtures/native-geocoding-policy.swift', import.meta.url));
    const common = ['swiftc', '-parse-as-library', '-sdk', sdk,
      '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
      '-module-cache-path', join(directory, 'modules'),
      '-framework', 'MapKit', '-framework', 'CoreLocation', '-framework', 'Contacts', '-framework', 'Foundation'];
    execFileSync('xcrun', [...common, '-D', major >= 26 ? 'ASIDE_MAPKIT_ADDRESS_FORMATTING' : 'ASIDE_LEGACY_MAPKIT_FORMATTING',
      source, fixture, '-o', binary], {timeout: 180_000, maxBuffer: 4 * 1024 * 1024});
    compatibilityArgs = [...common, '-D', 'ASIDE_LEGACY_MAPKIT_FORMATTING', '-typecheck', source];
  }, 240_000);

  afterAll(() => { if (directory) rmSync(directory, {recursive: true, force: true}); });

  it('searches addresses and POIs together while preserving candidates, errors, and cancellation', () => {
    expect(execFileSync(binary, {encoding: 'utf8', timeout: 10_000})).toContain('native geocoding policy passed');
  });

  it.each([
    {}, {query: null}, {query: ''}, {query: ' \n '}, {query: 1}, {query: true},
    {query: 'query\0'}, {address: 'Street'}, {place: 'Place'},
    {query: 'Place', locale: 'en-US'}, {query: 'Place', mode: 'AUTO'},
    {query: 'Place', address: 'Street'}, {query: 'Place', unknown: 'field'},
  ])('rejects invalid native request %j before search can run', input => {
    const response = JSON.parse(execFileSync(binary, ['request'], {
      input: JSON.stringify(input), encoding: 'utf8', timeout: 5_000,
    }));
    expect(response.status).toBe('FAILED');
    expect(response.candidates).toEqual([]);
    expect(typeof response.error).toBe('string');
  });

  it.each([
    {latitude: 91, longitude: 0, radiusMeters: 1000},
    {latitude: 0, longitude: 181, radiusMeters: 1000},
    {latitude: 0, longitude: 0, radiusMeters: 0},
    {latitude: 0, longitude: 0, radiusMeters: 20000001},
  ])('rejects invalid region hints before search: %j', region => {
    const response = JSON.parse(execFileSync(binary, ['request'], {
      input: JSON.stringify({query: 'Place', region}),
      encoding: 'utf8', timeout: 5_000,
    }));
    expect(response.status).toBe('FAILED');
    expect(response.error).toContain('Region requires');
  });

  it('compiles the legacy map-item formatting path without SDK26 address APIs', () => {
    execFileSync('xcrun', compatibilityArgs, {timeout: 120_000, maxBuffer: 4 * 1024 * 1024});
  }, 150_000);
});

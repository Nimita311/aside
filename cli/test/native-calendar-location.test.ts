import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

describe.skipIf(process.platform !== 'darwin')('native Calendar locations', () => {
  let directory: string;
  let binary: string;
  beforeAll(() => {
    directory = mkdtempSync('/tmp/aside-calendar-location-');
    binary = join(directory, 'probe');
    const native = readFileSync(new URL('../native/aside-native/Calendar.swift', import.meta.url), 'utf8');
    const timing = native.slice(native.indexOf('func parseWall('), native.indexOf('// The action-identity portion'));
    const operation = native.slice(native.indexOf('func markerIdentity('), native.indexOf('// Remove the event a marker'))
      .replaceAll('EKEvent(eventStore: store)', 'fixtureEvent()');
    const event = native.slice(native.indexOf('func eventDict('), native.indexOf('// Aside-marked events'));
    const fixture = readFileSync(new URL('./fixtures/native-calendar-location.swift', import.meta.url), 'utf8');
    const source = join(directory, 'probe.swift');
    writeFileSync(source, fixture.replace('// ASIDE_CALENDAR_FUNCTIONS', `${timing}\n${operation}\n${event}`));
    const sdk = process.env.SDKROOT || execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], {encoding: 'utf8'}).trim();
    execFileSync('xcrun', ['swiftc', '-sdk', sdk, '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`,
      '-module-cache-path', join(directory, 'modules'), '-framework', 'EventKit', '-framework', 'CoreLocation',
      '-framework', 'Foundation', source, '-o', binary], {timeout: 180_000, maxBuffer: 4 * 1024 * 1024});
  }, 240_000);
  afterAll(() => { if (directory) rmSync(directory, {recursive: true, force: true}); });

  it.each(['postal', 'point', 'preserve-clear', 'invalid', 'recurrence', 'readback'])(
    'supports %s through the actual upsert/readback paths without Calendar writes', name => {
      expect(execFileSync(binary, [name], {encoding: 'utf8', timeout: 10_000}))
        .toContain(`native Calendar location ${name} passed`);
    });
});

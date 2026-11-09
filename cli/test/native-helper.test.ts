import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { nativeBinPath, nativeCommand } from '../src/native/helper.js';

afterEach(() => vi.unstubAllEnvs());

describe('shared native command resolution', () => {
  it('resolves source imports to the unified executable in cli/dist', () => {
    vi.stubEnv('ASIDE_NATIVE_BIN', '');
    const file = fileURLToPath(new URL('../dist/aside-native', import.meta.url));
    expect(nativeBinPath()).toBe(file);
    expect(nativeCommand('calendar')).toEqual({ file, args: ['calendar'] });
    expect(nativeCommand('system-events')).toEqual({ file, args: ['system-events'] });
  });

  it('dispatches every mode through the global override', () => {
    vi.stubEnv('ASIDE_NATIVE_BIN', '/fixtures/native');
    expect(nativeCommand('geocode')).toEqual({ file: '/fixtures/native', args: ['geocode'] });
    expect(nativeCommand('pick-instance')).toEqual({ file: '/fixtures/native', args: ['pick-instance'] });
    expect(nativeCommand('default-browser')).toEqual({ file: '/fixtures/native', args: ['default-browser'] });
  });

  it('keeps legacy paths, disabling and per-mode environment overrides ahead of the unified helper', () => {
    vi.stubEnv('ASIDE_NATIVE_BIN', '/fixtures/native');
    vi.stubEnv('ASIDE_CAL_BIN', '/fixtures/calendar');
    expect(nativeCommand('calendar', { legacyEnv: 'ASIDE_CAL_BIN' })).toEqual({ file: '/fixtures/calendar', args: [] });
    expect(nativeCommand('calendar', { legacyEnv: 'ASIDE_CAL_BIN', legacyPath: '/fixtures/explicit' })).toEqual({ file: '/fixtures/explicit', args: [] });
    expect(nativeCommand('calendar', { legacyEnv: 'ASIDE_CAL_BIN', legacyPath: null })).toBeNull();
  });

  it('preserves injected worker commands and legacy stand-ins without adding mode arguments', () => {
    vi.stubEnv('ASIDE_NATIVE_BIN', '/fixtures/global');
    expect(nativeCommand('system-events', { nativePath: '/fixtures/worker' })).toEqual({ file: '/fixtures/worker', args: ['system-events'] });
    expect(nativeCommand('system-events', { nativePath: '/fixtures/worker', legacyPath: '/fixtures/wake' })).toEqual({ file: '/fixtures/wake', args: [] });
    vi.stubEnv('ASIDE_GEO_BIN', '/fixtures/geocoder');
    expect(nativeCommand('geocode', { nativePath: '/fixtures/worker', legacyEnv: 'ASIDE_GEO_BIN' })).toEqual({ file: '/fixtures/geocoder', args: [] });
  });
});

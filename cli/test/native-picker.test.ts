import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { pickInstance } from '../src/web/picker.js';

vi.mock('node:child_process', () => ({execFile: vi.fn()}));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe.skipIf(process.platform !== 'darwin')('native instance picker', () => {
  it.each(['directory', 'manifest'] as const)('dispatches %s selection through the unified binary', async kind => {
    vi.stubEnv('ASIDE_NATIVE_BIN', '/test/aside-native');
    vi.mocked(execFile).mockImplementation(((_command, _args, _options, callback) => {
      callback(null, '/private/tmp/ Aside instance \n', ''); return {};
    }) as typeof execFile);
    expect(await pickInstance(kind)).toBe('/private/tmp/ Aside instance ');
    expect(execFile).toHaveBeenCalledExactlyOnceWith('/test/aside-native', ['pick-instance', kind], expect.any(Object), expect.any(Function));
  });

  it('treats cancelling the panel as no selection', async () => {
    vi.mocked(execFile).mockImplementation(((_command, _args, _options, callback) => {
      callback(null, '', ''); return {};
    }) as typeof execFile);
    expect(await pickInstance('directory')).toBeNull();
  });

  it('reports native picker failures without returning a selected path', async () => {
    vi.mocked(execFile).mockImplementation(((_command, _args, _options, callback) => {
      callback(new Error('Native process failed'), '', 'No graphical session'); return {};
    }) as typeof execFile);
    await expect(pickInstance('manifest')).rejects.toThrow('Could not open the native picker: No graphical session');
  });
});

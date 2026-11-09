import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { openBrowser } from '../src/web/locate.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe.skipIf(process.platform !== 'darwin')('macOS browser handoff launch', () => {
  it('uses the default HTTP browser instead of the HTML file association', async () => {
    vi.stubEnv('ASIDE_NATIVE_BIN', '/test/aside-native');
    vi.mocked(execFile).mockImplementation(((command, args, _options, callback) => {
      callback(null, args[0] === 'default-browser' ? '/Applications/Example Browser.app\n' : '', '');
      return {};
    }) as typeof execFile);
    expect(await openBrowser('file:///private/state/random.html')).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith('open', ['-a', '/Applications/Example Browser.app', 'file:///private/state/random.html'], expect.any(Object), expect.any(Function));
    expect(execFile).toHaveBeenNthCalledWith(1, '/test/aside-native', ['default-browser'], expect.any(Object), expect.any(Function));
  });

  it('reports an unavailable browser without sending the handoff to another file handler', async () => {
    vi.mocked(execFile).mockImplementation(((_command, _args, _options, callback) => {
      callback(new Error('No browser'), '', ''); return {};
    }) as typeof execFile);
    expect(await openBrowser('file:///private/state/random.html')).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('keeps ordinary web links on the system URL handler', async () => {
    vi.mocked(execFile).mockImplementation(((_command, _args, _options, callback) => {
      callback(null, '', ''); return {};
    }) as typeof execFile);
    expect(await openBrowser('http://localhost:24800/work/')).toBe(true);
    expect(execFile).toHaveBeenCalledExactlyOnceWith('open', ['http://localhost:24800/work/'], expect.any(Object), expect.any(Function));
  });

  it('rejects an invalid native browser path instead of opening the private handoff elsewhere', async () => {
    vi.mocked(execFile).mockImplementation(((_command, _args, _options, callback) => {
      callback(null, 'relative-editor-path\n', ''); return {};
    }) as typeof execFile);
    expect(await openBrowser('file:///private/state/random.html')).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

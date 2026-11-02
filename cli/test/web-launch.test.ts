import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { openBrowser } from '../src/web/locate.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe.skipIf(process.platform !== 'darwin')('macOS browser handoff launch', () => {
  it('uses the default HTTP browser instead of the HTML file association', async () => {
    vi.mocked(execFile).mockImplementation(((command, args, _options, callback) => {
      callback(null, command === '/usr/bin/osascript' ? '/Applications/Example Browser.app\n' : '', '');
      return {};
    }) as typeof execFile);
    expect(await openBrowser('file:///private/state/random.html')).toBe(true);
    expect(execFile).toHaveBeenLastCalledWith('open', ['-a', '/Applications/Example Browser.app', 'file:///private/state/random.html'], expect.any(Object), expect.any(Function));
    expect(vi.mocked(execFile).mock.calls[0][1]?.join(' ')).toContain('http://localhost');
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
});

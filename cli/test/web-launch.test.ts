import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { openBrowser } from '../src/web/locate.js';
vi.mock('node:child_process', () => ({execFile: vi.fn()}));
afterEach(() => vi.resetAllMocks());
describe.skipIf(process.platform !== 'darwin')('macOS browser URL launch', () => {
  it('opens an HTTP URL using the system handler and reports launch failure', async () => {
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => callback(null)) as any);
    expect(await openBrowser('http://localhost:24800/work')).toBe(true);
    expect(execFile).toHaveBeenCalledWith('open', ['http://localhost:24800/work'], expect.any(Object), expect.any(Function));
    vi.mocked(execFile).mockImplementation(((_cmd: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => callback(new Error('Headless'))) as any);
    expect(await openBrowser('http://localhost:24800/work')).toBe(false);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

const directories: string[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map(worker => worker.terminate()));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe.runIf(process.platform === 'darwin')('automation native notifications', () => {
  it.each(['nativeBinary', 'wakeBinary'] as const)('routes %s without changing the notification protocol', async key => {
    const directory = mkdtempSync('/tmp/aside-events-'); directories.push(directory);
    const binary = join(directory, 'helper.cjs'), argsPath = join(directory, 'args.json');
    writeFileSync(binary, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argsPath)},JSON.stringify(process.argv.slice(2)));process.stdout.write('ready\\tUTC\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));\n`);
    chmodSync(binary, 0o755);
    const worker = new Worker(new URL('../dist/automation-worker.js', import.meta.url), { workerData: { storage: join(directory, 'runs'), [key]: binary } });
    workers.push(worker);
    const failure = new Promise<never>((_resolve, reject) => worker.on('error', reject));
    await Promise.race([failure, vi.waitFor(() => expect(existsSync(argsPath)).toBe(true))]);
    expect(JSON.parse(readFileSync(argsPath, 'utf8'))).toEqual(key === 'nativeBinary' ? ['system-events'] : []);
    const closed = new Promise<void>(resolve => worker.on('exit', () => resolve()));
    worker.postMessage({ type: 'close' });
    await Promise.race([failure, closed]);
  });
});

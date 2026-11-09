// Standalone context-allocation probe. It sends only the fixed synthetic text
// below, and does not alter saved model definitions or start/stop Ollama.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:11434' },
  model: { type: 'string', default: 'qwen3-embedding:0.6b' },
  contexts: { type: 'string', default: '32768,8192' },
  output: { type: 'string' },
} });
const base = values.url.replace(/\/$/, '');
const text = 'A disposable benchmark sentence about restoring archived notes.';
const call = async (path, body) => {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`);
  return response.json();
};
const output = { model: values.model, text, ollamaVersion: await call('/api/version'),
  note: 'One-sentence equivalence and allocation probe only. Reported model allocation is not independent process RSS. First call at each context may reload the model.', runs: [] };
let reference;
for (const context of values.contexts.split(',').map(Number)) {
  if (!Number.isSafeInteger(context) || context < 512 || context > 131072) throw new Error('Contexts must be integers in 512–131072.');
  const start = performance.now();
  const embedding = await call('/api/embed', { model: values.model, input: [text], truncate: false, options: { num_ctx: context } });
  const ms = performance.now() - start;
  const vector = embedding.embeddings[0];
  reference ??= vector;
  const ps = await call('/api/ps');
  const loaded = ps.models.find(item => item.name === values.model || item.name === `${values.model}:latest`);
  output.runs.push({ requestedContext: context, reportedContext: loaded?.context_length, ms,
    modelBytes: loaded?.size, gpuBytes: loaded?.size_vram, digest: loaded?.digest, dimension: vector.length,
    cosineAgainstFirst: vector.reduce((sum, value, index) => sum + value * reference[index], 0) / Math.hypot(...vector) / Math.hypot(...reference),
    maxAbsoluteDifference: Math.max(...vector.map((value, index) => Math.abs(value - reference[index]))) });
}
if (values.output) writeFileSync(resolve(values.output), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify(output, null, 2));

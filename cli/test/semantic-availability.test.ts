import { afterEach, describe, expect, it, vi } from 'vitest';
import { semanticSearchAvailability } from '../src/semantic/availability.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

const model = 'qwen3-embedding:0.6b';
const digest = 'a'.repeat(64), reference = `sha256:${digest}`;
const metadata = (name = model, revision = digest) => new Response(JSON.stringify({models: [{name, digest: revision}]}));
const shown = () => new Response(JSON.stringify({capabilities: ['embedding']}));
const native = () => Promise.resolve(undefined);
const options = {model, url: 'http://127.0.0.1:11434', platform: 'darwin' as const, arch: 'arm64', checkNative: native};

describe('semantic search availability', () => {
  it('checks installed model and digest support using metadata without loading a runner or embedding text', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(metadata()).mockResolvedValueOnce(shown());
    const checkNative = vi.fn(native);
    expect(await semanticSearchAvailability({...options, fetch, checkNative})).toEqual({
      available: true, reason: 'AVAILABLE', model,
      message: `Semantic ranking is available with ${model}.`, recovery: null,
    });
    expect(checkNative).toHaveBeenCalledOnce();
    expect(checkNative).toHaveBeenCalledWith();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:11434/api/tags', expect.objectContaining({method: 'GET', signal: expect.any(AbortSignal)}));
    expect(fetch).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:11434/api/show', expect.objectContaining({
      method: 'POST', signal: expect.any(AbortSignal), body: JSON.stringify({model: reference}),
    }));
  });

  it('uses the daemon environment configuration and recognizes latest-tag aliases', async () => {
    vi.stubEnv('ASIDE_EMBEDDING_URL', 'http://localhost:22434/');
    vi.stubEnv('ASIDE_EMBEDDING_MODEL', 'bge-m3');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(metadata('bge-m3:latest')).mockResolvedValueOnce(shown());
    const status = await semanticSearchAvailability({checkNative: native, fetch});
    expect(status).toMatchObject({available: true, model: 'bge-m3'});
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:22434/api/tags');
  });

  it('reports an installed service with a missing model and the exact recovery command', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('{"models":[]}'));
    expect(await semanticSearchAvailability({...options, fetch})).toMatchObject({
      available: false, reason: 'MODEL_MISSING', model,
      recovery: `Download the model explicitly with: ollama pull ${model}`,
    });
  });

  it('distinguishes a stopped/unreachable service from an HTTP error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('connection refused'));
    expect(await semanticSearchAvailability({...options, fetch})).toMatchObject({available: false, reason: 'OLLAMA_UNREACHABLE'});
    fetch.mockResolvedValue(new Response('', {status: 503}));
    expect(await semanticSearchAvailability({...options, fetch})).toMatchObject({available: false, reason: 'OLLAMA_ERROR', message: expect.stringContaining('503')});
  });

  it('reports an old service as unavailable when installed-model digests cannot be resolved', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(new Response('{"error":"model not found"}', {status: 404}));
    expect(await semanticSearchAvailability({...options, fetch})).toMatchObject({
      available: false, reason: 'OLLAMA_ERROR', model,
      message: expect.stringContaining('Ollama 0.40 or newer'),
      recovery: expect.stringContaining('Ollama 0.40 or newer'),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects models without embedding capabilities while retaining the configured model in status', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(metadata())
      .mockResolvedValueOnce(new Response('{"capabilities":["completion"]}'));
    expect(await semanticSearchAvailability({...options, fetch})).toMatchObject({
      available: false, reason: 'CONFIGURATION_ERROR', model,
      message: expect.stringContaining('embedding support'),
    });
  });

  it('rejects invalid installed digests before attempting a model lookup', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(metadata(model, 'sha256:incomplete'));
    expect(await semanticSearchAvailability({...options, fetch})).toMatchObject({available: false, reason: 'OLLAMA_ERROR'});
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects invalid configuration before loading native code or contacting a service', async () => {
    const checkNative = vi.fn(native), fetch = vi.fn<typeof globalThis.fetch>();
    for (const invalid of [{url: 'not a url'}, {url: 'file:///tmp/ollama'}, {url: 'http://user:password@localhost:11434'}, {model: ''}, {model: 'x'.repeat(257)}]) {
      expect(await semanticSearchAvailability({...options, ...invalid, fetch, checkNative})).toMatchObject({available: false, reason: 'CONFIGURATION_ERROR'});
    }
    expect(checkNative).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('reports unsupported native platforms and missing packages before contacting Ollama', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(), checkNative = vi.fn(native);
    expect(await semanticSearchAvailability({...options, arch: 'x64', fetch, checkNative})).toMatchObject({available: false, reason: 'UNSUPPORTED_PLATFORM'});
    expect(checkNative).not.toHaveBeenCalled();
    expect(await semanticSearchAvailability({...options, fetch, checkNative: async () => { throw new Error('missing binary'); }})).toMatchObject({available: false, reason: 'INDEX_UNAVAILABLE'});
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['null', '{}', '{"models":[null]}', '{"models":[{}]}', '{"models":[{"name":"test"}]}', '{"models":[{"name":123,"digest":"sha256:x"}]}', 'not JSON'])('rejects invalid metadata: %s', async body => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body));
    expect(await semanticSearchAvailability({...options, fetch})).toMatchObject({available: false, reason: 'OLLAMA_ERROR'});
  });

  it('bounds the metadata response size', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('x'.repeat(4 * 1024 * 1024 + 1)));
    expect(await semanticSearchAvailability({...options, fetch})).toMatchObject({available: false, reason: 'OLLAMA_ERROR'});
  });

  it('propagates caller cancellation and never converts it into unavailability', async () => {
    const controller = new AbortController(); controller.abort(new Error('caller cancelled'));
    const fetch = vi.fn<typeof globalThis.fetch>(), checkNative = vi.fn(native);
    await expect(semanticSearchAvailability({...options, fetch, checkNative, signal: controller.signal})).rejects.toThrow('caller cancelled');
    expect(checkNative).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });

  it('bounds unreachable probes with a short timeout', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    }));
    expect(await semanticSearchAvailability({...options, fetch, timeoutMs: 10})).toMatchObject({available: false, reason: 'OLLAMA_UNREACHABLE', message: expect.stringContaining('10 ms')});
  });

  it('propagates cancellation during digest verification', async () => {
    const controller = new AbortController(), cancelled = new Error('Digest probe cancelled');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(metadata()).mockImplementationOnce(async (_url, init) => {
      controller.abort(cancelled);
      init!.signal!.throwIfAborted();
      return shown();
    });
    await expect(semanticSearchAvailability({...options, fetch, signal: controller.signal})).rejects.toBe(cancelled);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares one timeout budget across discovery and digest verification', async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async (_url, init) => {
      signals.push(init!.signal!);
      return metadata();
    }).mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      const signal = init!.signal!; signals.push(signal);
      signal.addEventListener('abort', () => reject(signal.reason), {once: true});
    }));
    expect(await semanticSearchAvailability({...options, fetch, timeoutMs: 10})).toMatchObject({available: false, reason: 'OLLAMA_UNREACHABLE'});
    expect(signals).toHaveLength(2);
    // The shared availability deadline also aborts discovery's request signal,
    // rather than giving verification a separate full timeout.
    expect(signals.every(signal => signal.aborted)).toBe(true);
  });
});

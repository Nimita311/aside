import { afterEach, describe, expect, it, vi } from 'vitest';
import { OllamaEmbedder, QWEN_CONTEXT_LENGTH, SemanticGenerationUnavailableError, SemanticSetupError, validateVectors } from '../src/semantic/embedding.js';
afterEach(() => vi.restoreAllMocks());

const digest = 'a'.repeat(64), reference = `sha256:${digest}`;
const metadata = (model = 'qwen3-embedding:0.6b', selected = digest) => ({models: [{name: model, digest: selected}]});
const details = {capabilities: ['embedding']};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status});
function server(model = 'qwen3-embedding:0.6b') {
  const requests: Array<{path: string; body?: any}> = [];
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname, body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.push({path, body});
    return json(path === '/api/tags' ? metadata(model) : path === '/api/show' ? details : {model: body.model, embeddings: body.input.map(() => [1, 2, 3])});
  });
  return {requests, fetch};
}

describe('Ollama embedding generations', () => {
  it('resolves metadata once and pins documents and instructed queries to the full digest', async () => {
    const f = server(), generation = await new OllamaEmbedder().resolveGeneration();
    expect(Object.isFrozen(generation)).toBe(true);
    expect(generation.identity).toContain(`@${digest}`);
    expect(generation.identity).toContain(`context:${QWEN_CONTEXT_LENGTH}`);
    expect(f.requests).toEqual([{path: '/api/tags', body: undefined}, {path: '/api/show', body: {model: reference}}]);
    expect(await generation.embed(['document'])).toEqual([[1, 2, 3]]);
    await generation.embedQuery!('question');
    expect(f.requests.map(request => request.path)).toEqual(['/api/tags', '/api/show', '/api/embed', '/api/embed']);
    expect(f.requests[2].body).toEqual({model: reference, input: ['document'], truncate: false, options: {num_ctx: 8192}});
    expect(f.requests[3].body.model).toBe(reference);
    expect(f.requests[3].body.input[0]).toContain('Instruct:');
    expect(f.requests[3].body.input[0]).toContain('Query: question');
  });

  it('keeps old bindings on their digest when the configured name moves, and fails if old weights disappear', async () => {
    const nextDigest = 'b'.repeat(64), nextReference = `sha256:${nextDigest}`;
    let selected = digest, removed = false;
    const requests: Array<{path: string; body?: any}> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname, body = init?.body ? JSON.parse(init.body as string) : undefined;
      requests.push({path, body});
      if (path === '/api/tags') return json(metadata('qwen3-embedding:0.6b', selected));
      if (path === '/api/show') {selected = nextDigest; return json(details);}
      if (removed && body.model === reference) return json({error: 'generation was removed'}, 404);
      return json({model: body.model, embeddings: body.input.map(() => body.model === reference ? [1, 0] : [0, 1])});
    });
    const embedder = new OllamaEmbedder(), first = await embedder.resolveGeneration();
    expect(await first.embedQuery!('old')).toEqual([1, 0]);
    const second = await embedder.resolveGeneration();
    expect(second.identity).not.toBe(first.identity);
    expect(await second.embedQuery!('new')).toEqual([0, 1]);
    expect(await first.embedQuery!('still old')).toEqual([1, 0]);
    const resolutions = requests.filter(request => request.path !== '/api/embed').length;
    removed = true;
    await expect(first.embedQuery!('missing')).rejects.toBeInstanceOf(SemanticGenerationUnavailableError);
    expect(requests.filter(request => request.path !== '/api/embed')).toHaveLength(resolutions);
    expect(requests.filter(request => request.path === '/api/embed').map(request => request.body.model)).toEqual([reference, nextReference, reference, reference]);
  });

  it('rejects a response from a different generation instead of using its vector', async () => {
    const f = server(), generation = await new OllamaEmbedder().resolveGeneration();
    f.fetch.mockResolvedValueOnce(json({model: 'qwen3-embedding:0.6b', embeddings: [[1, 2, 3]]}));
    await expect(generation.embedQuery!('question')).rejects.toMatchObject({name: 'SemanticGenerationUnavailableError', reason: 'OLLAMA_ERROR'});
  });

  it('pins the selected child when metadata describes multiple model manifests', async () => {
    const child = 'c'.repeat(64), childReference = `sha256:${child}`;
    const f = server();
    f.fetch.mockResolvedValueOnce(json(metadata()))
      .mockResolvedValueOnce(json({...details, manifests: [
        {digest: childReference, selected: true}, {digest: 'd'.repeat(64), selected: false},
      ]})).mockResolvedValueOnce(json(details));
    const generation = await new OllamaEmbedder().resolveGeneration();
    expect(generation.identity).toContain(`@${child}`);
    expect(JSON.parse(f.fetch.mock.calls[2][1]!.body as string)).toEqual({model: childReference});
    await generation.embedQuery!('question');
    expect(f.requests.at(-1)!.body.model).toBe(childReference);
  });

  it.each([
    [], null, [null], [{digest}], [{digest, selected: 'true'}],
    [{digest, selected: true}, {digest: 'b'.repeat(64), selected: true}],
    [{digest: 'short', selected: true}],
  ])('rejects ambiguous or malformed manifest selection: %s', async manifests => {
    const f = server();
    f.fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json({...details, manifests}));
    await expect(new OllamaEmbedder().resolveGeneration()).rejects.toMatchObject({
      reason: 'OLLAMA_ERROR', message: expect.stringContaining('manifest selection'),
    });
  });

  it('rejects a selected child that cannot be addressed independently', async () => {
    const f = server(), child = 'c'.repeat(64);
    f.fetch.mockResolvedValueOnce(json(metadata()))
      .mockResolvedValueOnce(json({...details, manifests: [{digest: child, selected: true}]}))
      .mockResolvedValueOnce(json({...details, manifests: [{digest, selected: true}]}));
    await expect(new OllamaEmbedder().resolveGeneration()).rejects.toBeInstanceOf(SemanticGenerationUnavailableError);
  });

  it('reports unsupported digest references without name fallback, downloads, model copies or inference', async () => {
    const f = server();
    f.fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json({error: 'model not found'}, 404));
    await expect(new OllamaEmbedder().resolveGeneration()).rejects.toMatchObject({
      reason: 'OLLAMA_ERROR', message: expect.stringContaining('Ollama 0.40 or newer'), recovery: expect.stringContaining('Ollama 0.40 or newer'),
    });
    expect(f.fetch.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(['/api/tags', '/api/show']);
  });

  it('preserves other model input and reports context rejection without truncation', async () => {
    const f = server('bge-m3'), generation = await new OllamaEmbedder({model: 'bge-m3'}).resolveGeneration();
    await generation.embed(['document']);
    expect(f.requests.at(-1)!.body).toEqual({model: reference, input: ['document'], truncate: false});
    f.fetch.mockRestore();
    const qwen = server(), qwenGeneration = await new OllamaEmbedder().resolveGeneration();
    qwen.fetch.mockResolvedValueOnce(json({error: 'input length exceeds maximum context length'}, 400));
    await expect(qwenGeneration.embed(['long input'])).rejects.toThrow('8192-token context with truncation disabled');
  });

  it('gives setup errors for unavailable services, absent configured models and non-embedding models', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('connection refused'));
    const embedder = new OllamaEmbedder();
    await expect(embedder.resolveGeneration()).rejects.toMatchObject({reason: 'OLLAMA_UNREACHABLE'});
    fetch.mockResolvedValueOnce(json({models: []}));
    await expect(embedder.resolveGeneration()).rejects.toMatchObject({reason: 'MODEL_MISSING', message: expect.stringContaining('ollama pull')});
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json({capabilities: ['completion']}));
    await expect(embedder.resolveGeneration()).rejects.toMatchObject({reason: 'CONFIGURATION_ERROR'});
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('/pull'))).toBe(true);
  });

  it('validates vectors and propagates cancellation without making requests', async () => {
    expect(() => validateVectors([[1, 2], [1]], 2)).toThrow('dimension changed');
    expect(() => validateVectors([], 1)).toThrow('number of vectors');
    expect(() => validateVectors([[0, 0]], 1)).toThrow('zero vector');
    expect(() => validateVectors([[Infinity]], 1)).toThrow('invalid vector');
    const controller = new AbortController(); controller.abort(new Error('cancelled'));
    const f = server(), embedder = new OllamaEmbedder();
    await expect(embedder.resolveGeneration({signal: controller.signal})).rejects.toThrow('cancelled');
    expect(f.fetch).not.toHaveBeenCalled();
    const generation = await embedder.resolveGeneration(); f.fetch.mockClear();
    await expect(generation.embed(['document'], {signal: controller.signal})).rejects.toThrow('cancelled');
    expect(f.fetch).not.toHaveBeenCalled();
    expect(await generation.embed([])).toEqual([]);
    await expect(generation.embed(['x'.repeat(32_001)])).rejects.toThrow('Embedding batch exceeds');
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([
    'not JSON', 'null', '{}', '{"models":null}', '{"models":[null]}',
    '{"models":[{"name":"test","digest":123}]}', '{"models":[{"name":"test","digest":""}]}',
    '{"models":[{"name":"test","digest":"short-digest"}]}',
  ])('preserves structured failure details for invalid model metadata: %s', async body => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    const request = new OllamaEmbedder({model: 'test'}).resolveGeneration();
    await expect(request).rejects.toBeInstanceOf(SemanticSetupError);
    await expect(request).rejects.toMatchObject({reason: 'OLLAMA_ERROR', model: 'test', recovery: expect.any(String)});
  });

  it.each([undefined, null, [], [[0, 0]], [[1, null]]])('preserves structured failure details for invalid vectors: %s', async embeddings => {
    const f = server('test'), generation = await new OllamaEmbedder({model: 'test'}).resolveGeneration();
    f.fetch.mockResolvedValueOnce(json({model: reference, embeddings}));
    const request = generation.embed(['document']);
    await expect(request).rejects.toBeInstanceOf(SemanticSetupError);
    await expect(request).rejects.toMatchObject({reason: 'OLLAMA_ERROR', model: 'test', recovery: expect.any(String)});
  });

  it('propagates cancellation during metadata response handling', async () => {
    const controller = new AbortController(), cancelled = new Error('caller cancelled');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {controller.abort(cancelled); return json(metadata());});
    await expect(new OllamaEmbedder().resolveGeneration({signal: controller.signal})).rejects.toBe(cancelled);
  });
});

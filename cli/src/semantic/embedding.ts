import type { SemanticAvailabilityReason } from './availability.js';

export interface EmbeddingOptions { signal?: AbortSignal }

/** Bound operations must always use this generation's weights, or fail. */
export interface SemanticEmbeddingGeneration {
  readonly model: string;
  readonly identity: string;
  embed(texts: string[], options?: EmbeddingOptions): Promise<number[][]>;
  embedQuery?(query: string, options?: EmbeddingOptions): Promise<number[]>;
}

/** Only lifecycle work resolves a mutable configured model name. */
export interface SemanticEmbedder {
  readonly model: string;
  resolveGeneration(options?: EmbeddingOptions): Promise<SemanticEmbeddingGeneration>;
}

export const QWEN_QUERY_INSTRUCTION = 'Given a web search query, retrieve relevant passages that answer the query';
// Aside passages are short; limiting Qwen's allocated context avoids the much
// larger default context cache without changing chunk or query input bounds.
export const QWEN_CONTEXT_LENGTH = 8192;

const modelDigest = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return;
  const digest = value.replace(/^sha256:/, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
};

export class SemanticSetupError extends Error {
  readonly reason: Exclude<SemanticAvailabilityReason, 'AVAILABLE'>;
  readonly recovery: string | null;
  readonly model: string | null;
  constructor(message: string, details: {reason?: Exclude<SemanticAvailabilityReason, 'AVAILABLE'>; recovery?: string; model?: string} = {}) {
    super(message);
    this.name = 'SemanticSetupError';
    this.reason = details.reason ?? 'OLLAMA_ERROR';
    this.recovery = details.recovery ?? null;
    this.model = details.model ?? null;
  }
}

/** Retrieval reports this failure so the instance lifecycle can resolve again. */
export class SemanticGenerationUnavailableError extends SemanticSetupError {
  constructor(model: string, detail = 'The pinned embedding model generation is unavailable.') {
    super(`${detail} Semantic search requires Ollama 0.40 or newer with model digest support.`, {
      reason: 'OLLAMA_ERROR', model,
      recovery: 'Use Ollama 0.40 or newer and keep the configured embedding model installed. Retry after the instance lifecycle refreshes its model generation.',
    });
    this.name = 'SemanticGenerationUnavailableError';
  }
}

export function validateVectors(vectors: unknown, count: number, dimension?: number): number[][] {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new Error('Embedding service returned an unexpected number of vectors.');
  let size = dimension;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || !vector.length || vector.length > 65536 || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('Embedding service returned an invalid vector; expected finite numeric values.');
    }
    size ??= vector.length;
    if (vector.length !== size) throw new Error(`Embedding dimension changed (expected ${size}, received ${vector.length}).`);
    if (!vector.some(value => value !== 0)) throw new Error('Embedding service returned a zero vector.');
  }
  return vectors as number[][];
}

/** No downloads or process startup: Ollama and the selected model must already exist. */
export class OllamaEmbedder implements SemanticEmbedder {
  readonly model: string;
  readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: { model?: string; url?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch } = {}) {
    this.model = options.model ?? process.env.ASIDE_EMBEDDING_MODEL ?? 'qwen3-embedding:0.6b';
    this.url = (options.url ?? process.env.ASIDE_EMBEDDING_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetcher = options.fetch ?? ((...args) => globalThis.fetch(...args));
    let parsed: URL;
    try { parsed = new URL(this.url); }
    catch { throw this.failure('ASIDE_EMBEDDING_URL must be an HTTP(S) URL without embedded credentials.', 'CONFIGURATION_ERROR', 'Correct ASIDE_EMBEDDING_URL in the daemon environment and restart the daemon.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw this.failure('ASIDE_EMBEDDING_URL must be an HTTP(S) URL without embedded credentials.', 'CONFIGURATION_ERROR', 'Correct ASIDE_EMBEDDING_URL in the daemon environment and restart the daemon.');
    if (!this.model.trim() || this.model.length > 256) throw this.failure('Embedding model must be a nonempty model name of at most 256 characters.', 'CONFIGURATION_ERROR', 'Correct ASIDE_EMBEDDING_MODEL in the daemon environment and restart the daemon.');
  }

  private failure(message: string, reason: Exclude<SemanticAvailabilityReason, 'AVAILABLE'>, recovery: string): SemanticSetupError {
    return new SemanticSetupError(message, {reason, recovery, model: this.model});
  }

  private async request(path: string, options: EmbeddingOptions, body?: unknown, generation?: string): Promise<unknown> {
    options.signal?.throwIfAborted();
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(this.timeoutMs)]);
    try {
      const response = await this.fetcher(`${this.url}${path}`, {
        method: body === undefined ? 'GET' : 'POST', signal,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      signal.throwIfAborted();
      if (!response.ok) {
        await response.body?.cancel();
        if (generation && (response.status === 404 || path === '/api/show' && response.status === 400)) {
          throw new SemanticGenerationUnavailableError(this.model, `Cannot access pinned embedding generation ${generation} (HTTP ${response.status}).`);
        }
        if (response.status === 400 && path === '/api/embed' && this.model.startsWith('qwen3-embedding')) {
          throw this.failure(`Ollama rejected the embedding input (HTTP 400). Qwen3 uses a ${QWEN_CONTEXT_LENGTH}-token context with truncation disabled; shorten input that exceeds this context, or check the local model configuration.`, 'OLLAMA_ERROR', 'Shorten the input or check the configured embedding model.');
        }
        throw this.failure(`Ollama embedding request failed (HTTP ${response.status}). Check the local service and model ${this.model}.`, 'OLLAMA_ERROR', 'Check the configured Ollama endpoint and embedding model, then retry.');
      }
      // Bound a misconfigured endpoint's response as well as its execution time.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Embedding service returned an empty response.');
      const limitMiB = path === '/api/embed' ? 32 : 4;
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read(); signal.throwIfAborted(); if (done) break;
        bytes += value.length;
        if (bytes > limitMiB * 1024 * 1024) { await reader.cancel(); throw new Error(`Embedding service response exceeded ${limitMiB} MiB.`); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof SemanticSetupError) throw error;
      if (signal.aborted) throw this.failure(`Ollama embedding request timed out after ${this.timeoutMs} ms. Retry, or use a smaller model.`, 'OLLAMA_ERROR', 'Check that Ollama is responding, then retry.');
      if (error instanceof TypeError) throw this.failure(`Cannot reach Ollama at ${this.url}. Install Ollama from https://ollama.com if needed. Start Ollama explicitly, then install the model with: ollama pull ${this.model}`, 'OLLAMA_UNREACHABLE', `Install Ollama from https://ollama.com if needed, start it, and run: ollama pull ${this.model}`);
      throw this.failure(`Ollama returned an invalid response: ${error instanceof Error ? error.message : String(error)}`, 'OLLAMA_ERROR', 'Check that the configured endpoint serves the Ollama API and returns valid JSON.');
    }
  }

  async resolveGeneration(options: EmbeddingOptions = {}): Promise<SemanticEmbeddingGeneration> {
    const data = await this.request('/api/tags', options) as { models?: Array<{ name?: string; model?: string; digest?: string }> };
    if (!data || !Array.isArray(data.models) || data.models.some(item => item === null || typeof item !== 'object'
      || !((typeof item.name === 'string' && item.name) || (typeof item.model === 'string' && item.model))
      || typeof item.digest !== 'string' || !item.digest)) {
      throw this.failure('Ollama returned an invalid model list.', 'OLLAMA_ERROR', 'Check that the configured endpoint serves the Ollama API.');
    }
    const name = this.model.includes(':') ? this.model : `${this.model}:latest`;
    const found = data.models.find(item => item.name === name || item.model === name || item.name === this.model);
    if (!found?.digest) throw this.failure(`Embedding model ${this.model} is unavailable. Install it explicitly with: ollama pull ${this.model}`, 'MODEL_MISSING', `ollama pull ${this.model}`);
    let digest = modelDigest(found.digest);
    if (!digest) throw this.failure('Ollama returned an invalid model digest.', 'OLLAMA_ERROR', 'Check that the configured endpoint serves the Ollama API and returns a full SHA256 model digest.');
    let reference = `sha256:${digest}`;
    // Metadata-only native digest resolution. It does not load a model runner.
    // Never fall back to the configured name if its former digest was removed.
    const selectedDigest = (details: any): string | undefined => {
      if (!details || !Array.isArray(details.capabilities) || !details.capabilities.includes('embedding')) {
        throw this.failure(`Model ${this.model} does not expose embedding support through Ollama.`, 'CONFIGURATION_ERROR', 'Use Ollama 0.40 or newer and select an installed embedding model.');
      }
      if (details.manifests === undefined) return;
      const manifests: unknown = details.manifests;
      if (!Array.isArray(manifests) || !manifests.length || manifests.some(item => !item || typeof item !== 'object'
        || !modelDigest(item.digest) || item.selected !== undefined && typeof item.selected !== 'boolean')
        || manifests.filter(item => item.selected === true).length !== 1) {
        throw this.failure('Ollama returned an invalid or ambiguous model manifest selection.', 'OLLAMA_ERROR', 'Check that Ollama reports exactly one selected model manifest with a full SHA256 digest.');
      }
      return modelDigest(manifests.find(item => item.selected === true)!.digest)!;
    };
    const selected = selectedDigest(await this.request('/api/show', options, {model: reference}, reference));
    if (selected && selected !== digest) {
      // A list digest can select different runner weights. Bind its selected
      // child, so later server preference changes cannot change this generation.
      digest = selected;
      reference = `sha256:${digest}`;
      const confirmed = selectedDigest(await this.request('/api/show', options, {model: reference}, reference));
      if (confirmed && confirmed !== digest) throw new SemanticGenerationUnavailableError(this.model, 'Ollama selected different weights for the requested model digest.');
    }
    const identity = `${this.model}@${digest}${this.model.startsWith('qwen3-embedding') ? `\nquery-instruction-v1:${QWEN_QUERY_INSTRUCTION}\ncontext:${QWEN_CONTEXT_LENGTH}` : ''}`;
    return Object.freeze({model: this.model, identity,
      embed: (texts: string[], request?: EmbeddingOptions) => this.embedGeneration(reference, texts, request),
      embedQuery: async (query: string, request?: EmbeddingOptions) => {
        const text = this.model.startsWith('qwen3-embedding') ? `Instruct: ${QWEN_QUERY_INSTRUCTION}\nQuery: ${query}` : query;
        return (await this.embedGeneration(reference, [text], request))[0];
      },
    });
  }

  private async embedGeneration(reference: string, texts: string[], options: EmbeddingOptions = {}): Promise<number[][]> {
    options.signal?.throwIfAborted();
    if (!texts.length) return [];
    if (texts.length > 64 || texts.some(text => typeof text !== 'string' || text.length > 32_000)) throw new Error('Embedding batch exceeds 64 texts or 32000 characters per text.');
    const data = await this.request('/api/embed', options, {
      model: reference, input: texts, truncate: false,
      ...(this.model.startsWith('qwen3-embedding') ? { options: { num_ctx: QWEN_CONTEXT_LENGTH } } : {}),
    }, reference) as {model?: unknown; embeddings?: unknown};
    if (!data || data.model !== reference) throw new SemanticGenerationUnavailableError(this.model, 'Ollama did not confirm the requested embedding model digest.');
    try { return validateVectors(data?.embeddings, texts.length); }
    catch (error) {
      options.signal?.throwIfAborted();
      throw this.failure(error instanceof Error ? error.message : String(error), 'OLLAMA_ERROR', 'Check that the configured embedding model returns valid, nonzero vectors of a consistent dimension.');
    }
  }

}

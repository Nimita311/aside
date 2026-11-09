import {OllamaEmbedder, SemanticSetupError} from './embedding.js';

export type SemanticAvailabilityReason = 'AVAILABLE' | 'UNSUPPORTED_PLATFORM' | 'INDEX_UNAVAILABLE'
  | 'OLLAMA_UNREACHABLE' | 'MODEL_MISSING' | 'CONFIGURATION_ERROR' | 'OLLAMA_ERROR';

export interface SemanticAvailability {
  available: boolean;
  reason: SemanticAvailabilityReason;
  message: string;
  recovery: string | null;
  model: string;
}

export interface SemanticAvailabilityOptions {
  signal?: AbortSignal;
  model?: string;
  url?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Test seam; production only loads the packaged native module. */
  checkNative?: () => Promise<unknown>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const pullCommand = (model: string) => `ollama pull ${/^[\w./:@-]+$/.test(model) ? model : `'${model.replace(/'/g, `'\\''`)}'`}`;

/** Check dependencies through local module loading and metadata reads only. */
export async function semanticSearchAvailability(options: SemanticAvailabilityOptions = {}): Promise<SemanticAvailability> {
  options.signal?.throwIfAborted();
  const model = options.model ?? process.env.ASIDE_EMBEDDING_MODEL ?? 'qwen3-embedding:0.6b';
  const url = (options.url ?? process.env.ASIDE_EMBEDDING_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 3000;
  const result = (reason: SemanticAvailabilityReason, message: string, recovery: string | null): SemanticAvailability =>
    ({available: reason === 'AVAILABLE', reason, message, recovery, model});

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    if (!model.trim() || model.length > 256 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error();
  } catch {
    return result('CONFIGURATION_ERROR', 'Semantic search has invalid embedding configuration.',
      'Set ASIDE_EMBEDDING_URL to an HTTP(S) Ollama URL without credentials and ASIDE_EMBEDDING_MODEL to a nonempty model name of at most 256 characters, then restart the daemon.');
  }

  if ((options.platform ?? process.platform) === 'darwin' && (options.arch ?? process.arch) === 'x64') {
    return result('UNSUPPORTED_PLATFORM', 'Semantic search is unavailable on Intel Macs with the current native index package.',
      'Use an Apple Silicon Mac or a supported native index platform. Field ordering and regex search remain available.');
  }
  try {
    await (options.checkNative ?? (async () => {
      const native = await import('@lancedb/lancedb');
      if (typeof native.connect !== 'function') throw new Error('Invalid native index module.');
    }))();
    options.signal?.throwIfAborted();
  } catch {
    options.signal?.throwIfAborted();
    return result('INDEX_UNAVAILABLE', 'The native semantic index module could not be loaded.',
      'Rebuild or reinstall Aside with its LanceDB native sidecar. Field ordering and regex search remain available.');
  }

  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    // The same lifecycle adapter verifies that the installed model can be
    // addressed by immutable digest. Both discovery and pin verification read
    // metadata only; no text is embedded and no model is loaded or downloaded.
    const embedder = new OllamaEmbedder({model, url, timeoutMs, fetch: options.fetch});
    await embedder.resolveGeneration({signal});
    signal.throwIfAborted();
    return result('AVAILABLE', `Semantic ranking is available with ${model}.`, null);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (timeout.aborted) return result('OLLAMA_UNREACHABLE', `Ollama did not respond within ${timeoutMs} ms.`,
      `Check that Ollama is running at ${url}, then retry.`);
    if (error instanceof SemanticSetupError) {
      if (error.reason === 'MODEL_MISSING') return result('MODEL_MISSING', error.message,
        `Download the model explicitly with: ${pullCommand(model)}`);
      return result(error.reason, error.message, error.recovery);
    }
    if (error instanceof TypeError) return result('OLLAMA_UNREACHABLE', `Cannot reach Ollama at ${url}.`,
      'Install Ollama from https://ollama.com if needed, then start it.');
    return result('OLLAMA_ERROR', 'Ollama returned invalid model metadata.',
      `Check the Ollama service at ${url} and the configured embedding model.`);
  }
}

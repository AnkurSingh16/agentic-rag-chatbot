import { DEFAULT_EMBEDDING_MODELS, EMBEDDING_DIMENSIONS } from '../config/schema.js';
import { ChatbotError, toChatbotError } from '../errors.js';
import type { EmbeddingProvider } from './types.js';

export const LOCAL_EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODELS.local;
export const DEFAULT_MODEL_CACHE_DIR = '.cache/models';

/** The callable a transformers.js `feature-extraction` pipeline provides. */
export type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: true },
) => Promise<{ tolist(): unknown }>;

export type PipelineFactory = (
  model: string,
  options: { cacheDir: string },
) => Promise<FeatureExtractor>;

export interface LocalEmbeddingOptions {
  model?: string;
  /** Where downloaded model files are kept. Defaults to {@link DEFAULT_MODEL_CACHE_DIR}. */
  cacheDir?: string;
  /** Injected in tests; defaults to transformers.js. */
  pipelineFactory?: PipelineFactory;
}

// Imported on first use so mock mode, tests and the server's other paths never load the ONNX
// runtime.
const transformersPipeline: PipelineFactory = async (model, { cacheDir }) => {
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', model, {
    cache_dir: cacheDir,
    // Pinned so the vectors for a model name never change with library defaults.
    dtype: 'fp32',
  });
  return extractor;
};

function isMatrix(value: unknown, rows: number): value is number[][] {
  return (
    Array.isArray(value) &&
    value.length === rows &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === EMBEDDING_DIMENSIONS &&
        row.every((cell) => typeof cell === 'number'),
    )
  );
}

/**
 * Embeds text inside Node with all-MiniLM-L6-v2 through transformers.js (ADR 0008): mean pooling
 * and L2 normalisation, 384 dimensions. The model is downloaded from Hugging Face on first use
 * and cached in `cacheDir`; after that it needs no network and no key.
 */
export function createLocalEmbeddingProvider(
  options: LocalEmbeddingOptions = {},
): EmbeddingProvider {
  const model = options.model ?? LOCAL_EMBEDDING_MODEL;
  const cacheDir = options.cacheDir ?? DEFAULT_MODEL_CACHE_DIR;
  const factory = options.pipelineFactory ?? transformersPipeline;
  let loading: Promise<FeatureExtractor> | undefined;

  function extractor(): Promise<FeatureExtractor> {
    loading ??= factory(model, { cacheDir }).catch((error: unknown) => {
      // A failed download must not stick; the next call tries again.
      loading = undefined;
      throw new ChatbotError(
        'provider_unavailable',
        `Could not load embedding model ${model}: ${toChatbotError(error).message}. ` +
          'The first run downloads it from Hugging Face; set EMBEDDING_PROVIDER=mock to work offline.',
        { cause: error },
      );
    });
    return loading;
  }

  return {
    provider: 'local',
    model,
    dimensions: EMBEDDING_DIMENSIONS,
    async embed(texts, signal) {
      signal.throwIfAborted();
      if (texts.length === 0) return [];
      const extract = await extractor();
      signal.throwIfAborted();
      const output = await extract([...texts], { pooling: 'mean', normalize: true });
      const vectors = output.tolist();
      if (!isMatrix(vectors, texts.length)) {
        throw new ChatbotError(
          'provider_unavailable',
          `Embedding model ${model} did not return ${texts.length} vectors of ${EMBEDDING_DIMENSIONS} dimensions`,
        );
      }
      return vectors;
    },
  };
}

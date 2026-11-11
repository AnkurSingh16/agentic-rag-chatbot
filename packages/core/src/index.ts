export { ChatbotError, isChatbotError, toChatbotError } from './errors.js';
export type { ChatbotErrorOptions, ErrorCode } from './errors.js';

export {
  ACCESS_MODES,
  DEFAULT_EMBEDDING_MODELS,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_PROVIDERS,
  chunkingSchema,
  instanceConfigSchema,
} from './config/schema.js';
export type {
  AccessMode,
  AuthConfig,
  ChunkingConfig,
  EmbeddingConfig,
  EmbeddingProviderName,
  InstanceConfig,
  InstanceConfigInput,
  LimitsConfig,
  Permission,
  SourceConfig,
} from './config/schema.js';
export { assertBootSafe, authModeOverrideVariable, loadInstanceConfig } from './config/load.js';
export type { Environment, LoadedInstanceConfig } from './config/load.js';

export {
  CHUNKER_VERSION,
  DEFAULT_CHUNKING,
  chunkMarkdown,
  chunkerHash,
  contentSha256,
  estimateTokens,
} from './chunking/chunker.js';
export type { Chunk, ChunkInput } from './chunking/chunker.js';

export {
  MOCK_EMBEDDING_MODEL,
  createMockEmbeddingProvider,
  noopReranker,
} from './providers/mock-embeddings.js';
export {
  DEFAULT_MODEL_CACHE_DIR,
  LOCAL_EMBEDDING_MODEL,
  createLocalEmbeddingProvider,
} from './providers/local-embeddings.js';
export type {
  FeatureExtractor,
  LocalEmbeddingOptions,
  PipelineFactory,
} from './providers/local-embeddings.js';
export { createEmbeddingProvider, resolveEmbeddingConfig } from './providers/factory.js';
export type { EmbeddingProvider, RerankCandidate, Reranker } from './providers/types.js';

export { ZERO_USAGE, addUsage } from './llm/types.js';
export type {
  ChatMessage,
  ChatModel,
  ChatProviderName,
  ChatRequest,
  ChatStreamEvent,
  ChatTool,
  TokenUsage,
} from './llm/types.js';
export { formatContext, parseContext } from './llm/context.js';
export type { ContextDocument } from './llm/context.js';
export { MOCK_INSUFFICIENT_EVIDENCE, createMockChatModel } from './llm/mock.js';
export { createAnthropicChatModel } from './llm/anthropic.js';
export type { AnthropicChatModelOptions, AnthropicClientLike } from './llm/anthropic.js';
export { DEFAULT_CHAT_MODEL, createChatModel, resolveChatModels } from './llm/factory.js';

export { RETRIEVAL } from './retrieval/types.js';
export type {
  ActiveIndexVersion,
  RetrievalAccess,
  RetrievalStore,
  RetrievedChunk,
  SearchQuery,
} from './retrieval/types.js';

export {
  INSUFFICIENT_EVIDENCE_TEXT,
  TURN_BUDGET,
  fitContext,
  mergeResults,
  runChat,
  trimHistory,
} from './agent/run-chat.js';
export type { ChatOutcome, ModelCallRecord, RunChatOptions } from './agent/run-chat.js';
export {
  CITATION,
  MAX_MESSAGE_CHARS,
  SHINGLE_WORDS,
  checkParagraph,
  guardInput,
  instructionShingles,
} from './agent/guards.js';
export type { OutputPolicy, ParagraphCheck, ParagraphFailure } from './agent/guards.js';
export type { ChatEvent, FinalState, GraphNode } from './agent/events.js';

export { hasPermission, resolveAccessTags, resolvePermissions } from './access/access.js';
export type { AccessContext } from './access/access.js';

export type {
  ActivationRequest,
  CachedEmbedding,
  ChunkRecord,
  DocumentRecord,
  EvalRunSummary,
  IndexVersionStatus,
  IndexVersionSummary,
  IngestStore,
  NewEvalRun,
  NewIndexVersion,
} from './store/types.js';

export { DEFAULT_MAX_DOCUMENT_BYTES, loadDocuments } from './training/sources.js';
export type { LoadedDocument, SourceAccess } from './training/sources.js';
export { MAX_REDIRECTS, isForbiddenAddress } from './training/url-fetch.js';
export type { FetchLike, LookupLike } from './training/url-fetch.js';
export { EMBEDDING_BATCH_SIZE, RETAINED_VERSIONS, train } from './training/train.js';
export type { TrainOptions, TrainResult } from './training/train.js';
export { activateVersion, evalGateFailure } from './training/activate.js';
export type { ActivateOptions, ActivateResult } from './training/activate.js';

export { evalSetSchema, parseEvalSet } from './eval/eval-set.js';
export { DEFAULT_MIN_RECALL, runRetrievalEval } from './eval/run-eval.js';
export type {
  EvalQuestionResult,
  RetrievalEvalOptions,
  RetrievalEvalResult,
} from './eval/run-eval.js';
export type { EvalQuestion, EvalSet } from './eval/eval-set.js';

export { ChatbotError, isChatbotError, toChatbotError } from './errors.js';
export type { ChatbotErrorOptions, ErrorCode } from './errors.js';

export {
  ACCESS_MODES,
  EMBEDDING_DIMENSIONS,
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
  FAKE_EMBEDDING_MODEL,
  createFakeEmbeddingProvider,
  noopReranker,
} from './providers/fake.js';
export type {
  ChatMessage,
  ChatModelProvider,
  ChatRequest,
  ChatStreamEvent,
  EmbeddingProvider,
  RerankCandidate,
  Reranker,
  TokenUsage,
} from './providers/types.js';

export { hasPermission, resolveAccessTags, resolvePermissions } from './access/access.js';
export type { AccessContext } from './access/access.js';

# ADR 0008: Model access and cost controls

## Status

Accepted. Supersedes the embedding provider and dimension choices in ADR 0006.

## Context

The owner develops on a Claude subscription and does not want any other paid Claude usage during development. Two constraints follow:

- A chatbot that visitors use must call Claude through the Anthropic API with its own API key. It must never use the owner's subscription, `claude -p` or a Claude Code login.
- Local development, unit tests and CI must work with no key and cost nothing.

ADR 0006 chose Voyage for embeddings, which is a second paid API.

## Decision

**Model providers.** All model calls go through one interface in `packages/core/src/llm/` with two implementations, chosen by `LLM_PROVIDER`:

| Provider         | Use                                                                                                                                      | Cost                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `mock` (default) | Local development, unit and integration tests, CI. Deterministic responses, including tool-call flows, built from the retrieved context. | None                |
| `anthropic`      | Live mode. Official `@anthropic-ai/sdk`, with `ANTHROPIC_API_KEY` read from the application's `.env` only.                               | Anthropic API usage |

The default model is `claude-haiku-5-5`, set by `LLM_MODEL`. An instance can override it in `models.chat`, for example with `claude-sonnet-5-5`.

**Spend controls:**

- **Prompt caching.** The system prompt and the retrieved context are sent as separate blocks marked for caching. A prompt shorter than the model's minimum cacheable length is not cached; the usage log shows whether a request hit the cache.
- **Limits per instance.** `maxOutputTokens` (default 512), `maxTurnsPerSession` (default 20), requests per minute per IP in public mode, and `dailyRequests` (default 500). Every limit fails closed with a `rate_limited` or `budget_exhausted` error.
- **Usage logging.** Every model call logs instance, model, input tokens, output tokens, cache-read tokens and cache-write tokens, and adds them to the daily `usage_counters` row.

**Embeddings.** Two providers behind the existing `EmbeddingProvider` interface:

| Provider | Model                                                                  | Dimensions |
| -------- | ---------------------------------------------------------------------- | ---------- |
| `local`  | `Xenova/all-MiniLM-L6-v2` through transformers.js, running inside Node | 384        |
| `mock`   | deterministic hash vectors (renamed from `fake`)                       | 384        |

The local model is downloaded from Hugging Face on first use and cached on disk. It needs no key and has no per-request cost. A migration changes the vector columns to 384 dimensions.

**Vector store.** PostgreSQL with pgvector stays. SQLite with sqlite-vec was considered: it is a single file and needs no server. It was rejected because SQLite has no row-level security. Isolation between instances, tenants and access tags (ADR 0003) would move into application code, where one missing filter leaks data. SQLite also allows only one writer at a time. PostgreSQL runs locally in Docker and on low-cost managed hosts.

## Consequences

- Development and CI never need an API key. CI runs with `LLM_PROVIDER=mock` and `EMBEDDING_PROVIDER=mock`.
- Live mode is billed by Anthropic per use, separately from any Claude subscription. The limits above cap the worst case per instance and per day.
- The first local-embedding run downloads the model, so it needs internet access once.
- Indexes built at 1024 dimensions must be rebuilt.
- Retrieval quality with a small local model is measured by the eval harness rather than assumed.

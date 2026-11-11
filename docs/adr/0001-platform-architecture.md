# ADR 0001: Platform architecture and package boundaries

## Status

Accepted

## Context

The platform must serve several unrelated consumers (Aegis AI, a static personal website, future apps) from one codebase. Each consumer needs its own chatbot with its own data and access rules. The stack is fixed to Node.js, React and React Native with TypeScript. Consumers embed the chatbot either in-process (a Fastify app such as Aegis) or over HTTP (a static site).

## Options considered

1. **Single deployable service only.** Simple, but forces Aegis to call a second service and duplicate its identity checks.
2. **Library-first monorepo with a thin deployable app.** The same plugin runs inside a consumer's Fastify server or inside our own `apps/server`.
3. **Separate services for ingestion, retrieval and chat.** Better isolation of workloads; three things to deploy and monitor for a corpus measured in megabytes.

## Decision

Option 2.

| Package                 | Responsibility                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`                  | Agent graph, retrieval orchestration, chunking, provider interfaces, access types. No I/O singletons. Must not import Fastify, React, React Native or `pg`. |
| `server`                | Fastify plugin, HTTP and SSE transport, the PostgreSQL implementation of the storage port.                                                                  |
| `client`                | Headless streaming client. Runs in browsers and React Native; `fetch` is injected.                                                                          |
| `react`, `react-native` | UI components and hooks over `client`. `react` also builds the script-tag bundle.                                                                           |
| `cli`                   | `ragctl`. Reuses the storage implementation from `server`.                                                                                                  |
| `apps/server`           | Composes the plugin with configuration loading. Hosts many instances.                                                                                       |

`core` reaches storage through a `RagStore` port and models through `ChatModelProvider`, `EmbeddingProvider` and `Reranker`. Its main entry points:

```ts
runChat(ctx: RunContext, input: ChatInput, emit: (event: ChatEvent) => void, signal: AbortSignal): Promise<ChatOutcome>;
train(ctx: TrainContext, sources: SourceSpec[]): Promise<IndexVersion>;
retrieve(ctx: RetrievalContext, queries: string[]): Promise<RetrievedChunk[]>;
```

dependency-cruiser enforces the boundaries in CI. All cross-package failures use `ChatbotError`.

Deferred: a queue or worker process for ingestion, Redis, a separate storage package.

## Consequences

- Aegis mounts the plugin in-process and supplies its own identity resolution (ADR 0003, ADR 0007).
- Running cost stays at one container plus one PostgreSQL database.
- Training runs in the CLI process, so large corpora will need the deferred worker later.

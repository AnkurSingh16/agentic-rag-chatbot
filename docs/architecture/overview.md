# Architecture overview

One Node.js server hosts many chatbot instances. Each instance answers only from its own documents, under its own access mode. The decisions behind this page are in [docs/adr](../adr/README.md).

> Status: design accepted (phase 1). Implementation starts in phase 2.

## Context

```mermaid
flowchart TB
  visitor([Website visitor]) --> site[ankursingh16.github.io<br/>static React site]
  user([Aegis user]) --> aegis[Aegis AI<br/>Fastify + React]
  mobile([Mobile user]) --> app[React Native app]
  site -->|widget script, POST + SSE| server[apps/server<br/>hosts many instances]
  app -->|POST + SSE| server
  aegis -->|in-process plugin| plugin[packages/server plugin]
  server --> plugin
  plugin --> pg[(PostgreSQL 17 + pgvector<br/>schema rag, forced RLS)]
  plugin --> llm[Chat model<br/>Anthropic or Ollama]
  plugin --> emb[Embeddings<br/>Voyage or Ollama]
  operator([Operator]) --> cli[ragctl]
  cli --> pg
  cli --> emb
```

## A chat request

```mermaid
sequenceDiagram
  participant C as Client
  participant S as Fastify plugin
  participant DB as PostgreSQL
  participant M as Chat model
  C->>S: POST /v1/instances/:id/chat (Accept: text/event-stream)
  S->>S: onRequest: verify token or public session, limits
  S->>DB: BEGIN REPEATABLE READ, set instance, tenant, tags
  S->>DB: resolveAccess (membership, roles)
  S->>DB: active index version check
  S->>DB: hybrid search (FTS + HNSW, RRF)
  S->>DB: COMMIT
  S->>M: route_and_rewrite, then answer
  M-->>S: paragraphs
  S->>S: verify each paragraph
  S-->>C: SSE meta, status, token, citation
  S-->>C: SSE final
```

The database transaction closes before any model call, so connections are never held during inference.

## Data model

```mermaid
erDiagram
  instances ||--o{ index_versions : has
  instances ||--o| index_versions : "active version"
  index_versions ||--o{ documents : contains
  documents ||--o{ chunks : "split into"
  index_versions ||--o{ eval_runs : "evaluated by"
  instances ||--o{ conversations : has
  conversations ||--o{ messages : has
  messages ||--o{ feedback : receives
  instances ||--o{ usage_counters : meters
```

Corpus rows (`documents`, `chunks`) carry `instance_id`, `tenant_key` and `access_tags`. Forced RLS filters them by the transaction's instance, an exact tenant match, and overlapping tags. Tables, policies, roles and the transaction pattern are described in [Data model](data-model.md).

## Where to read more

| Topic                             | ADR                                                           |
| --------------------------------- | ------------------------------------------------------------- |
| Schema, RLS policies and roles    | [Data model](data-model.md)                                   |
| Packages and boundaries           | [0001](../adr/0001-platform-architecture.md)                  |
| Instances, training, rollback     | [0002](../adr/0002-instances-and-index-versions.md)           |
| Access modes and RLS              | [0003](../adr/0003-access-modes-and-row-level-security.md)    |
| Public sessions and cost controls | [0004](../adr/0004-public-mode-sessions-and-cost-controls.md) |
| Agent graph, guards, streaming    | [0005](../adr/0005-agent-graph-streaming-and-guards.md)       |
| Retrieval and embeddings          | [0006](../adr/0006-retrieval-and-embeddings.md)               |
| Clients, Aegis, website           | [0007](../adr/0007-clients-and-consumer-integrations.md)      |

# ADR 0007: Clients and consumer integrations

## Status

Accepted

## Context

The chatbot must run in React web apps, React Native apps and plain web pages, and integrate with two known consumers:

- **Aegis AI**, a Fastify and React app with Auth0 tokens, tenant membership in PostgreSQL and forced RLS. Its ADR 003 requires forced RLS to check principal membership independently. Its ADRs 007 and 008 do not approve any cloud inference provider.
- **ankursingh16.github.io**, a static React site on GitHub Pages with no backend.

## Decision

**Shared client.** `packages/client` exposes:

```ts
createChatClient(options: {
  baseUrl: string;
  instanceId: string;
  getAccessToken?: () => Promise<string | null>;
  fetch?: typeof fetch;
}): { send(message: string, opts?: { signal?: AbortSignal }): AsyncIterable<ChatEvent> };
```

It parses SSE from the `fetch` response body. Browsers use the global `fetch`; Expo passes `fetch` from `expo/fetch`, which supports streamed bodies. `EventSource` is not used because it cannot send a `POST` body or an `Authorization` header. Sending `Accept: application/json` returns the complete answer in one response, as a fallback. The widgets never store access tokens; host apps provide them through `getAccessToken`.

**Web.** `packages/react` provides hooks and `<ChatWidget>`. It also builds a script-tag bundle that `apps/server` serves at an immutable, versioned path (`/v1/widget/<version>/widget.js`); the embed docs publish its SRI hash.

**Mobile.** `packages/react-native` provides hooks plus `<ChatScreen>` and `<ChatSheet>`.

**Personal website.** The `portfolio` instance runs in `public` mode on the hosted `apps/server`. The site lazy-loads the versioned widget script when the visitor opens the chat launcher. The API URL comes from `VITE_CHAT_API_URL` at build time, and the site's origin is added to the instance's `allowedOrigins`. Loading the script avoids needing authenticated access to GitHub Packages from the site's build.

**Aegis.** All of this is behind `AEGIS_RAG_ENABLED`, off by default, and is designed in an Aegis ADR at phase 9:

- The plugin is mounted in-process at `/api/rag`.
- The plugin gets its own `rag_runtime` connection pool, because Aegis's runtime role check forbids extra role memberships on `aegis_app`.
- An Aegis migration adds a `SELECT` policy on its principal memberships table for `rag_runtime`, using the same session settings as Aegis's existing policy. It also adds a `RESTRICTIVE` policy on `rag.chunks` for the `aegis` instance that requires a matching membership row. This is part of v1 of the integration, not deferred, so forced RLS checks membership independently, as Aegis ADR 003 requires.
- Aegis's `resolveAccess` runs inside the request transaction, using its existing token verification result and membership lookup, and returns the tenant UUID as `tenantKey`.
- An integration test proves that revoking a membership returns zero chunks.
- Instance config gains `requiredPolicies`: a list of policy names that must exist on `rag` tables. At boot and in the per-request version check (ADR 0002), the server reads `pg_policies` and refuses to serve the instance if any is missing. The `aegis` instance lists its restrictive policy, so a platform migration that recreates `rag.chunks` cannot silently remove it.
- **Migration ownership.** The platform owns the `rag` schema and its migrations, applied with `ragctl migrate`. Aegis's checksummed migration chain never references `rag.*`, so Aegis databases without the integration still migrate cleanly. Aegis applies its two policies with an idempotent setup command that runs after `ragctl migrate` and only when `AEGIS_RAG_ENABLED` is on. Any platform migration that drops or recreates a corpus table must say so in its PR and in the release notes.
- The `aegis` instance uses the `ollama` or `fake` providers for both chat and embeddings until an Aegis ADR approves a cloud provider.
- Aegis has no mobile app, so it gets no `<ChatSheet>`.

## Consequences

- One client implementation serves web and mobile; both get contract tests for `reset` and error handling.
- Publishing packages to npmjs needs the owner's npm account. This is an open decision, tracked in the "Waiting on Ankur" issue at phase 6.
- The Aegis-specific policies live in the Aegis repository, so the platform's own tests run without the Aegis schema.

## Dissent

Architect A proposed deferring the Aegis `RESTRICTIVE` policy, arguing that tenant equality from the same membership snapshot already covers the case and that cross-repository policies complicate migration order. Overruled: Aegis ADR 003 requires forced RLS to check membership independently of application code. The policy lives in the Aegis repository to keep migration ownership clear.

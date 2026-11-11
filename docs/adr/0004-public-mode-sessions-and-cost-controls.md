# ADR 0004: Public-mode sessions and cost controls

## Status

Accepted

## Context

A `public` instance, such as the one on the personal website, accepts anonymous traffic and spends model tokens on every message. The design review found two problems with a plain per-instance daily budget:

- Without a server-issued identity, per-session limits can be bypassed with fresh session IDs, and a caller-supplied conversation ID could expose another visitor's history.
- A budget that fails closed lets a single script take the instance offline for the rest of the day.

## Decision

**Sessions.** On first contact the server issues a signed session token (HMAC-SHA256, 24-hour expiry, random ID). Conversations are owned by `owner_key`, a hash of the session ID in `public` mode or of the token subject otherwise. A conversation ID never authorises access on its own: reading or continuing a conversation requires the matching owner key.

**Client IP.** Only taken from `X-Forwarded-For` when the deployment explicitly lists trusted proxies (`TRUSTED_PROXIES`). Otherwise the socket address is used, and the server logs a warning the first time it sees an `X-Forwarded-For` header, because every visitor behind an untrusted proxy would share one address. IPv6 addresses are keyed by their /64 prefix, so one host cannot rotate through its own prefix to multiply its allowance.

**Session issuance** is itself rate-limited per IP, so new sessions cannot be minted faster than the per-IP request limit.

**Limits, in the order they are checked:**

1. Request body cap: 8 KiB. Message length cap: 2,000 characters.
2. Optional bot-challenge hook in the plugin options (`verifyChallenge(request)`), off by default.
3. Request rate per IP and per session (per minute).
4. Token budget per IP per day.
5. Token budget per instance per day.
6. Global token budget per day across all instances.

Counters live in PostgreSQL (`usage_counters` per instance; a separate `usage_global` table with its own policy for `rag_runtime`), updated atomically with `UPDATE … RETURNING`, so limits hold across replicas. Exceeding a limit returns the `rate_limited` or `budget_exhausted` error code. The per-IP budget sits ahead of the instance budget so that one client exhausts its own allowance before it can affect anyone else.

The counter function records every call in full, so real spend is never dropped. Its only bound is an overflow guard: it rejects a single call adding more than 10,000,000 tokens or 1,000 requests, so one bad call cannot push the shared global counter to the `bigint` maximum and make every later call fail for the rest of the day.

## Consequences

- Required tests. In place since PR #21: session issuance is rate-limited, one session cannot read or continue another's conversation (unit and PostgreSQL integration over HTTP), spoofed `X-Forwarded-For` is ignored without a trusted proxy, IPv6 addresses are keyed by /64, and the per-IP minute limit, both daily request caps and the turn limit each return 429 at their configured value (`packages/server/test/unit/app.test.ts`, `packages/server/test/integration/chat.test.ts`, `packages/server/test/unit/session-limits.test.ts`). Outstanding, with the controls they test (#22): session rotation does not reset the per-IP token budget; one /64 shares a budget end to end; each token budget trips at its configured value.
- Distributed attacks from many IPs can still exhaust the instance budget. This risk is accepted for v1; the challenge hook is the mitigation.

## Amendment (PR #21)

PR #21 is a mock-first slice: it makes the chat path work end to end with the mock model and adds the controls needed to run live mode locally. It implements sessions, owner-keyed conversations, the body and message caps, the per-IP minute limit (`@fastify/rate-limit`, in each process's memory), daily **request** caps per IP (`limits.dailyRequestsPerIp`) and per instance (`limits.dailyRequests`) through `rag.consume_usage`, a turn limit per session (`limits.maxTurnsPerSession`) and token counting into `usage_counters`.

Not implemented yet:

- the request rate per session per minute;
- the daily **token** budgets per IP, per instance and globally (tokens are counted, not enforced);
- a per-minute limit shared across replicas;
- the bot-challenge hook.

Worst case without the token budgets, from the code paths in PR #21 (input estimated as characters ÷ 4, the same estimate the code enforces; cache reads and writes count as input):

| Item                          | Bound                                                                      |
| ----------------------------- | -------------------------------------------------------------------------- |
| Model calls per request       | 3: route, answer, one answer retry                                         |
| Input per call                | 8,000 tokens, enforced before each call (`TURN_BUDGET.inputTokensPerCall`) |
| Output per call               | route 256; answer `limits.maxOutputTokens` (default 512, at most 4,096)    |
| Tokens per request (default)  | 3 × 8,000 + 256 + 2 × 512 = 25,280                                         |
| Requests per instance per day | `limits.dailyRequests` (default 500, at most 1,000,000)                    |
| **Per instance per day**      | **25,280 × 500 = 12,640,000 tokens at the defaults**                       |

At the configuration ceilings (4,096 output tokens, 1,000,000 requests) the bound is 32,448 tokens per request and about 32.4 billion tokens per instance per day, so the request cap, not the code, is what limits spend until the token budgets exist. The estimate can undercount for text that tokenizes at fewer than four characters per token.

Rule: **no instance is exposed publicly until these controls are implemented; tracked in #22.** Live mode is for local use behind a loopback address, with an Anthropic Console spend limit.

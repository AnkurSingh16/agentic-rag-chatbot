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

## Consequences

- Required tests: session rotation does not reset the per-IP budget; addresses in one IPv6 /64 share a budget; session issuance is rate-limited; one session cannot read another's conversation; spoofed `X-Forwarded-For` is ignored without a trusted proxy; each limit trips at its configured value.
- Distributed attacks from many IPs can still exhaust the instance budget. This risk is accepted for v1; the challenge hook is the mitigation.

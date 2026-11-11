# ADR 0003: Access modes and row-level security

## Status

Accepted

## Context

Each instance runs in one of three access modes, chosen at build or deploy time: `public`, `authenticated` or `rbac`. In `rbac`, a user must never receive an answer drawn from a document they are not allowed to see. Hiding results in the UI is not sufficient; the restriction must hold inside the database query. Aegis already isolates tenants with forced RLS and a membership check in the same transaction (Aegis ADR 002, ADR 003); the platform must be able to preserve that model.

## Options considered

1. **Tenant as an access tag** (`tenant:<uuid>`) matched with the other tags. Rejected: tags match on any overlap, so a user holding `[tenant:north, faq]` would match a south document tagged `[tenant:south, faq]`.
2. **Separate `tenant_key` matched by equality, plus access tags matched by overlap.** Chosen.
3. **Application-side filtering only.** Rejected: one missing `WHERE` clause leaks data.

## Decision

**Access context.** The server derives an `AccessContext { instanceId, tenantKey, subject, permissions, accessTags }`. Nothing in a request body or URL authorises access.

| Mode            | Identity                                                        | Access tags                                               | Tenant key                                       |
| --------------- | --------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `public`        | server-issued session (ADR 0004)                                | `['public']`                                              | `_`                                              |
| `authenticated` | verified OIDC access token: issuer, audience, signature, expiry | instance `defaultTags`                                    | `_`                                              |
| `rbac`          | verified token; roles read from a configured claim              | each `docs:read:<tag>` permission granted by the role map | `_`, or supplied by a consumer's `resolveAccess` |

Permissions: `chat:use`, `docs:read:<tag>`, `instance:train`, `instance:admin`, `analytics:read`.

**Identity resolution.** Token verification runs in Fastify `onRequest`, before a database connection is taken, because fetching signing keys is a network call. Then `resolveAccess(client, principal, instance)` runs **inside** the request's repeatable-read transaction, so a consumer's membership check and the retrieval read share one snapshot. The default implementation maps the role claim. Aegis supplies its own (ADR 0007).

**Data model and RLS.** Schema `rag`. Every table holding instance data carries `instance_id`; corpus tables also carry `tenant_key` and `access_tags text[]` with at least one tag. All tables use `FORCE ROW LEVEL SECURITY`. The corpus policy:

```sql
instance_id = rag.current_instance()
AND tenant_key = rag.current_tenant()
AND access_tags && rag.current_access_tags()
```

The helper functions read transaction-local settings. A missing setting returns no rows.

Per request, inside `BEGIN ISOLATION LEVEL REPEATABLE READ`:

```sql
SELECT set_config('rag.instance_id', $1, true),
       set_config('rag.tenant_key', $2, true),
       set_config('rag.access_tags', $3, true);
```

The transaction commits before any model call, so no connection is held during inference.

**Database roles.** `rag_migrator` owns the schema. `rag_runtime` can read the corpus and write conversations, feedback, usage counters and analytics. `rag_ingest` can write the corpus and execute the activation function. None is a superuser, none has `BYPASSRLS`, and none inherits other roles; the server verifies these attributes at boot.

**Unsafe configurations fail boot:**

- a `public` instance whose active version holds any tag other than `public`;
- an environment override that changes `rbac` or `authenticated` to `public`;
- `authenticated` or `rbac` without issuer or audience, or `rbac` without a role claim;
- admin or training routes enabled for a `public` instance.

**Trust boundary.** As in Aegis ADR 002: whoever holds the runtime credential can set the session variables. RLS protects against missing filters in trusted server code. It does not authenticate anyone on its own.

## Consequences

- Every mode × endpoint combination, role escalation, wrong audience, expired token, tag-leak and missing-context case is a required test against real PostgreSQL with pgvector.
- Training and admin functions are only reachable through the CLI in `public` mode.

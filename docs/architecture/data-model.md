# Data model and row-level security

This page describes the PostgreSQL schema in `packages/server/db/migrations`, the roles that use it, and how a request sets the access context that row-level security (RLS) filters on. Read it before writing a query, a migration or a new policy.

> Status: the schema, migration runner, transaction helper, ingest store, hybrid retrieval and chat storage are implemented in `packages/server`, and `apps/server` and `ragctl` use them.

Design decisions: [ADR 0002](../adr/0002-instances-and-index-versions.md) (instances, index versions), [ADR 0003](../adr/0003-access-modes-and-row-level-security.md) (access modes, RLS, roles), [ADR 0004](../adr/0004-public-mode-sessions-and-cost-controls.md) (sessions, usage counters), [ADR 0006](../adr/0006-retrieval-and-embeddings.md) (hybrid search, HNSW), [ADR 0008](../adr/0008-model-access-and-cost-controls.md) (384-dimension embeddings).

## Run it locally

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD`, `RAG_RUNTIME_PASSWORD` and `RAG_INGEST_PASSWORD` (16 to 256 characters, runtime and ingest different). Fill in the three database URLs with those passwords.
2. Start PostgreSQL 17 with pgvector: `docker compose up -d`. It listens on `127.0.0.1:5433` only (`RAG_POSTGRES_PORT` changes it).
3. Build and migrate: `npm run build`, then `npm run db:migrate`.
4. Run the integration tests against it, with `TEST_DATABASE_ADMIN_URL`, `TEST_DATABASE_URL` and `TEST_DATABASE_INGEST_URL` set to the admin, runtime and ingest URLs: `npm run test:integration`.

The integration tests create rows under random instance IDs and do not clean up, so point them at a database you can throw away.

## Tables

All tables live in schema `rag`, are owned by `rag_migrator`, and have row-level security enabled and forced.

| Table               | Key                                    | Holds                                                                                                                                   |
| ------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `instances`         | `id` (`^[a-z][a-z0-9-]{1,39}$`)        | One row per chatbot. `active_index_version_id` points at the version being served.                                                      |
| `index_versions`    | `id` (uuid)                            | One training run: `status` (`building`, `ready`, `active`, `retired`), embedding provider, model and dimension, config hashes.          |
| `eval_runs`         | `id`                                   | Evaluation results for a version, with the embedding provider and model they ran with.                                                  |
| `activation_log`    | `id` (bigint identity)                 | One row per activation: version, `forced`, `reason`, `operator`, `activated_at`. No foreign key to the version, so it outlives pruning. |
| `documents`         | `id`                                   | Source documents of a version, with `tenant_key` and `access_tags`.                                                                     |
| `chunks`            | `id`                                   | Chunk text, generated `tsv`, `embedding vector(384)`, `tenant_key` and `access_tags`.                                                   |
| `embedding_cache`   | `(instance_id, model, content_sha256)` | Embeddings reused by incremental training. The key includes the instance so the cache never crosses instances.                          |
| `conversations`     | `id`                                   | Owned by `owner_key`, a hash of the session ID or token subject. Expires at most 30 days after creation.                                |
| `messages`          | `id`                                   | Conversation turns; carry `owner_key` so the owner policy needs no join.                                                                |
| `feedback`          | `id`                                   | A rating of -1 or 1 on a message, owned by the message's `owner_key`.                                                                   |
| `usage_counters`    | `(instance_id, scope, day)`            | Daily token and request counts per instance, IP prefix or session.                                                                      |
| `usage_global`      | `day`                                  | Daily token and request counts across all instances.                                                                                    |
| `schema_migrations` | `name`                                 | Applied migration files and their SHA-256 checksums.                                                                                    |

Integrity rules enforced by constraints:

- Corpus rows need `cardinality(access_tags) >= 1`; `tenant_key` defaults to `_`.
- Composite foreign keys tie every row to one instance: a version, document, chunk, message or feedback row cannot reference a row of another instance, a chunk's `tenant_key` must equal its document's, and a message or feedback row must have its conversation's `owner_key`.
- At most one version per instance is `active` (partial unique index). `activated_at` is set exactly for `active` and `retired` versions.
- `embedding_dimensions` must be 384, matching the column type (ADR 0008). Migration 0008 changed it from 1024; it fails while 1024-dimension rows exist, and the fix is to delete them and retrain.

Indexes on `chunks`: GIN on `tsv`, GIN on `access_tags`, B-tree on `(instance_id, index_version_id, tenant_key)`, and HNSW on `embedding vector_cosine_ops` with `m = 16, ef_construction = 64`.

## Access context

Policies read four transaction-local settings through helper functions:

| Setting           | Function                    | Value                                      |
| ----------------- | --------------------------- | ------------------------------------------ |
| `rag.instance_id` | `rag.current_instance()`    | Instance ID                                |
| `rag.tenant_key`  | `rag.current_tenant()`      | Tenant key, `_` when there is no tenant    |
| `rag.access_tags` | `rag.current_access_tags()` | Comma-separated tags, returned as `text[]` |
| `rag.owner_key`   | `rag.current_owner()`       | Conversation owner key                     |

An unset or empty setting returns NULL. A comparison with NULL is never true, so a missing setting returns no rows instead of all rows. The functions are `STABLE` and pin `search_path = pg_catalog, pg_temp`. Every function in `rag` pins its `search_path` with `pg_temp` last, so a temporary object can never shadow a catalog or `rag` name.

## Policies

Every policy names its role, so a role without a policy on a table sees nothing there, the owner included.

| Table                                   | `rag_runtime`                                                                        | `rag_ingest`                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `instances`                             | read own instance                                                                    | read and insert own instance                                                                                 |
| `index_versions`                        | read own instance                                                                    | read; insert as `building`; update only while `building`, to `building` or `ready`; delete when not `active` |
| `documents`, `chunks`                   | read where instance matches, `tenant_key` is equal and `access_tags` overlap (below) | read own instance; insert only into a `building` version                                                     |
| `eval_runs`, `embedding_cache`          | none                                                                                 | read and write own instance                                                                                  |
| `activation_log`                        | none                                                                                 | read and insert own instance; `activated_at` always comes from its default                                   |
| `conversations`, `messages`, `feedback` | read and write where instance and `owner_key` match                                  | none                                                                                                         |
| `usage_counters`                        | read own instance; increase only through `rag.consume_usage`                         | none                                                                                                         |
| `usage_global`                          | read when any instance context is set; increase only through `rag.consume_usage`     | none                                                                                                         |

The corpus policy, as in ADR 0003:

```sql
instance_id = rag.current_instance()
AND tenant_key = rag.current_tenant()
AND access_tags && rag.current_access_tags()
```

Tenants match by equality and tags by overlap, so a north user holding `faq` never sees a south document tagged `faq`.

Because corpus rows can only be inserted into a `building` version and `rag_ingest` can update only `building` versions, a version is immutable once it is `ready`. Rolling back serves exactly what was evaluated.

## Roles

| Role           | Login | Purpose                                                                                                                          |
| -------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `rag_migrator` | no    | Owns the schema and every object in it. Migrations run as this role.                                                             |
| `rag_runtime`  | yes   | The server. Reads the corpus; writes conversations, messages and feedback; increases usage counters through `rag.consume_usage`. |
| `rag_ingest`   | yes   | Training. Writes the corpus, records eval runs and executes `rag.activate_index_version`.                                        |

All three are `NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION`. Neither login role is a member of any role or has members. Column grants limit writes: `rag_runtime` can insert only `instance_id`, `owner_key` and `expires_at` into `conversations` (so `created_at` always comes from its default) and update only `expires_at`, which a CHECK keeps within 30 days of `created_at`; it has no direct write on the usage tables; `rag_ingest` can update only `status`, `document_count` and `chunk_count` on `index_versions`, and cannot update `instances` at all.

`verifyRuntimeRole(pool)` fails closed with a `ChatbotError` unless the pool logs in as `rag_runtime` with none of the rights above, no `CREATE` on the database or on schemas `public` and `rag`, and every `rag` table under forced RLS. `apps/server` calls it at boot and refuses to start when it fails (ADR 0003).

## Activating an index version

`rag.activate_index_version(instance_id, version_id, force, reason, operator)` is the only way to change the served version. It is `SECURITY DEFINER` with `search_path = pg_catalog, rag, pg_temp`, and only `rag_ingest` can execute it. It:

1. Requires `instance_id` to equal the caller's `rag.instance_id` setting (`42501`).
2. Requires a non-NULL `force` and a non-blank `operator`, and a non-blank `reason` when `force` is true (`22023`).
3. Locks the instance row, so concurrent activations of one instance run one after the other.
4. Accepts a `ready` version, or a `retired` one for rollback (`55000` otherwise).
5. Unless `force` is true, enforces the eval gate (ADR 0002): the version's latest `eval_runs` row, by `created_at` then `id`, must have `passed = true` and the version's own embedding provider and model (`55000` otherwise, with a message starting `eval gate:`).
6. Marks the active version `retired`, the new one `active`, and moves `instances.active_index_version_id`.
7. Inserts a row into `activation_log` with `forced`, the trimmed `reason` (NULL when blank) and the trimmed `operator`.
8. Returns the previously active version ID, or NULL.

The function runs as `rag_migrator`, which forced RLS also restricts. Policies give `rag_migrator` access to `instances`, `index_versions`, `eval_runs` (read) and `activation_log` (read and insert) of the current instance only. Migration 0007 dropped the earlier two-argument form, which had no gate.

The gate prevents accidental activation. It does not stop someone who holds the `rag_ingest` credential, because that role can also record an eval run; this is the same trust boundary as for `rag_runtime` below.

Keeping only the last three versions is done by `ragctl train`, not by the database.

## Consuming usage

`rag.consume_usage(scopes text[], tokens bigint, requests bigint)` is the only way to change the usage counters (ADR 0004). It is `SECURITY DEFINER` with `search_path = pg_catalog, rag, pg_temp`, and only `rag_runtime` can execute it. It:

1. Requires an instance context (`42501` otherwise) and rejects negative or NULL deltas, deltas above the overflow guard (more than 10,000,000 tokens or 1,000 requests in one call), and an empty or NULL-containing scope list (`22023`). The guard keeps one call from pushing the shared global counter to the `bigint` maximum; it is far above any real call, so real usage is always recorded in full (ADR 0004).
2. Adds the deltas to each distinct scope of the caller's instance in `usage_counters`, and once to `usage_global`, for the current UTC day, with `INSERT ... ON CONFLICT DO UPDATE`, so concurrent replicas cannot lose an increment.
3. Returns the new totals as rows of `(counter_scope, total_tokens, total_requests)`; the global row has a NULL `counter_scope`.

Counters only grow, so a leaked runtime credential can exhaust a budget but cannot reset one. Like activation, the function runs as `rag_migrator`, and two policies limit that role to the caller's instance counters and the global counter.

## Transaction pattern

Every query runs inside `withInstanceTransaction`:

```ts
import { withInstanceTransaction } from '@agentic-rag/server';

const chunks = await withInstanceTransaction(
  runtimePool,
  { instanceId: 'portfolio', tenantKey: '_', accessTags: ['public'], ownerKey },
  (client) =>
    client.query('SELECT id, content FROM rag.chunks WHERE index_version_id = $1', [versionId]),
);
```

It runs `BEGIN ISOLATION LEVEL REPEATABLE READ`, sets the four access settings plus `hnsw.iterative_scan = relaxed_order` and `hnsw.ef_search = 100` with `set_config(..., true)` (the same as `SET LOCAL`), runs the callback, and commits. On error it rolls back and rethrows as a `ChatbotError` with the database error on `cause`. A connection whose rollback fails is destroyed rather than returned to the pool. The settings end with the transaction, so they cannot leak to the next user of the connection.

The access context is validated first: instance ID format, tenant and owner keys of 1 to 128 characters, and tags of 1 to 128 characters with no commas or whitespace. An empty tag list is allowed and matches no corpus rows.

Finish the callback before calling a model; the connection is held until it returns.

## Migrations

`npm run db:migrate` runs `packages/server/dist/store/migrate-cli.js`. It reads `DATABASE_ADMIN_URL`, `RAG_RUNTIME_PASSWORD` and `RAG_INGEST_PASSWORD` from the environment or `.env`, and refuses a database host other than `localhost`, `127.0.0.1` or `[::1]` unless `--allow-remote` is passed (`npm run db:migrate -- --allow-remote`).

In one transaction under an advisory lock, the runner:

1. Creates `rag_migrator`, `rag_runtime` and `rag_ingest` if they are missing. Passwords are bound as parameters and used inside a `DO` block, so they never appear in SQL text or statement logs. Existing roles are checked and refused if unsafe, but never altered; rotate a password with `ALTER ROLE` as an administrator.
2. Grants `rag_migrator` to the administrator if it cannot already assume it.
3. Creates the `vector` extension in schema `public`, runs `REVOKE CREATE ON SCHEMA public FROM PUBLIC`, and creates schema `rag` owned by `rag_migrator`. These steps need administrator rights, which is why they are not in the migration files: pgvector is not a trusted extension.
4. Switches to `rag_migrator` and applies each pending file in name order, recording its SHA-256 checksum.

The `REVOKE CREATE ON SCHEMA public` step affects the whole database, not only `rag`: after it, only the owner of `public` and superusers can create objects there. It stops `rag_runtime` and `rag_ingest` from creating functions or operators in `public` that could shadow the ones queries resolve through `search_path`. PostgreSQL 15 and later already ship with this default, so on the supported PostgreSQL 17 it normally changes nothing. On a database shared with another application that still relies on creating objects in `public` as a non-owner, that application needs its own schema or an explicit grant before you run the migration.

It refuses to run when an applied file is missing or its checksum changed, when a new file sorts before an applied one, or when two files share a number. Never edit an applied migration; add a new one. A migration that drops or recreates a corpus table must say so in its PR and release notes (ADR 0007).

The administrator in `DATABASE_ADMIN_URL` needs to create roles, create the extension and change privileges on schema `public`. The Docker Compose superuser and the CI service container meet this.

## Trust boundary

As in ADR 0003: whoever holds the `rag_runtime` credential can set the session variables to any instance, tenant or tags. RLS protects against a missing or wrong filter in trusted server code; it does not authenticate anyone. Identity is verified before the transaction starts, and nothing in a request body or URL becomes an access setting without that check.

## Retrieval and chat queries

`createPostgresRetrievalStore(pool)` implements the core `RetrievalStore` port. Each call runs in `withInstanceTransaction`:

- `activeVersion` reads `instances.active_index_version_id` with the version's embedding provider and model. The agent graph refuses to answer when they differ from the server's embedding provider.
- `search` runs one statement per query against an explicit version: a full-text CTE (`websearch_to_tsquery('english', ...)`, ranked by `ts_rank_cd`, top 40) and a vector CTE (cosine distance through the HNSW index, top 40, dropping candidates with a distance above 0.8), fused with Reciprocal Rank Fusion (k = 60). Chunks with a fused score below 0.0165 are dropped, and the top 8 (16 on the verification retry) are returned. Constants: `RETRIEVAL` in `packages/core/src/retrieval/types.ts`.

With a `rag_runtime` pool the corpus policy applies the caller's tenant and tags; `ragctl eval` uses a `rag_ingest` pool, whose policy reads every chunk of the instance, to score a version before activation.

`createPostgresChatStore(pool)` (runtime role) creates and reads conversations under the session's owner key, appends user and assistant messages, counts the owner's user messages for `maxTurnsPerSession`, and calls `rag.consume_usage` with scopes `ip:<address or /64>` and `instance`.

## What the tests prove

Integration tests in `packages/server/test/integration` run against PostgreSQL with pgvector in CI:

- migrations apply, re-run without changes, and refuse a modified applied file;
- the three roles have no superuser, `BYPASSRLS`, inheritance or role-management rights, and `verifyRuntimeRole` rejects the admin and ingest credentials;
- every `rag` table has forced RLS and is owned by `rag_migrator`; every `rag` function pins `search_path` with `pg_temp` last; only `rag_ingest` can activate and only `rag_runtime` can consume usage;
- for every table in schema `rag`, read from `pg_tables` so a new table fails the test until it is classified, `rag_runtime` and `rag_ingest` see none of instance A's rows and cannot insert, update or delete them under instance B's context, and see zero rows with no context (`usage_global` is shared across instances by design and is checked only without context);
- instance A cannot read instance B's documents or chunks;
- a north user with tag `faq` cannot see a south chunk tagged `faq`; tags match on overlap; empty or unknown tags see nothing;
- a missing or incomplete access context returns zero rows, including on a reused connection;
- the HNSW index returns the nearest chunk the caller may see, not a closer one from another instance or tenant;
- `rag_runtime` cannot write the corpus or execute activation; `rag_ingest` can write only into a `building` version and cannot activate without the function;
- activation moves the pointer and retires the previous version; rollback to a retired version works; building, already active, foreign-instance and mismatched-context activations are refused;
- without `force`, activation is refused when the latest eval run is missing, failed or used another embedding model; with `force`, a missing or blank reason or operator is refused; every activation is logged, the log hides from `rag_runtime`, and `rag_ingest` cannot backdate a log row or log a forced activation without a reason; the two-argument function no longer exists;
- conversations, messages and feedback are visible only to their owner; another owner cannot add messages or feedback to them;
- conversation expiry is capped at 30 days after creation, and `created_at` cannot be supplied;
- usage counters only increase through `rag.consume_usage`; negative deltas, deltas above the overflow guard, a missing context and direct writes are rejected, and calls within the guard are recorded in full;
- a `ready` version cannot be edited or reopened by `rag_ingest`;
- hybrid retrieval over the trained demo documents (mock embeddings) reaches recall@8 of at least 0.6 on the demo eval set, ranks the matching document first for a paraphrase and for a keyword, and returns nothing for unrelated text, for other tags and for another instance;
- the chat API streams a cited answer from the active version, stores both turns under the session's owner key, adds requests and tokens to `rag.usage_counters`, and returns `404` when another session uses the conversation ID.

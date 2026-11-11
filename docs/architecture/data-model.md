# Data model and row-level security

This page describes the PostgreSQL schema in `packages/server/db/migrations`, the roles that use it, and how a request sets the access context that row-level security (RLS) filters on. Read it before writing a query, a migration or a new policy.

> Status: the schema, migration runner and transaction helper are implemented in `packages/server` (storage layer only). The HTTP server, retrieval queries and `ragctl` are planned.

Design decisions: [ADR 0002](../adr/0002-instances-and-index-versions.md) (instances, index versions), [ADR 0003](../adr/0003-access-modes-and-row-level-security.md) (access modes, RLS, roles), [ADR 0004](../adr/0004-public-mode-sessions-and-cost-controls.md) (sessions, usage counters), [ADR 0006](../adr/0006-retrieval-and-embeddings.md) (embeddings, HNSW).

## Run it locally

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD`, `RAG_RUNTIME_PASSWORD` and `RAG_INGEST_PASSWORD` (16 to 256 characters, runtime and ingest different). Fill in the three database URLs with those passwords.
2. Start PostgreSQL 17 with pgvector: `docker compose up -d`. It listens on `127.0.0.1:5432` only.
3. Build and migrate: `npm run build`, then `npm run db:migrate`.
4. Run the integration tests against it, with `TEST_DATABASE_ADMIN_URL`, `TEST_DATABASE_URL` and `TEST_DATABASE_INGEST_URL` set to the admin, runtime and ingest URLs: `npm run test:integration`.

The integration tests create rows under random instance IDs and do not clean up, so point them at a database you can throw away.

## Tables

All tables live in schema `rag`, are owned by `rag_migrator`, and have row-level security enabled and forced.

| Table               | Key                                    | Holds                                                                                                                          |
| ------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `instances`         | `id` (`^[a-z][a-z0-9-]{1,39}$`)        | One row per chatbot. `active_index_version_id` points at the version being served.                                             |
| `index_versions`    | `id` (uuid)                            | One training run: `status` (`building`, `ready`, `active`, `retired`), embedding provider, model and dimension, config hashes. |
| `eval_runs`         | `id`                                   | Evaluation results for a version, with the embedding provider and model they ran with.                                         |
| `documents`         | `id`                                   | Source documents of a version, with `tenant_key` and `access_tags`.                                                            |
| `chunks`            | `id`                                   | Chunk text, generated `tsv`, `embedding vector(1024)`, `tenant_key` and `access_tags`.                                         |
| `embedding_cache`   | `(instance_id, model, content_sha256)` | Embeddings reused by incremental training. The key includes the instance so the cache never crosses instances.                 |
| `conversations`     | `id`                                   | Owned by `owner_key`, a hash of the session ID or token subject.                                                               |
| `messages`          | `id`                                   | Conversation turns; carry `owner_key` so the owner policy needs no join.                                                       |
| `feedback`          | `id`                                   | A rating of -1 or 1 on a message.                                                                                              |
| `usage_counters`    | `(instance_id, scope, day)`            | Daily token and request counts per instance, IP prefix or session.                                                             |
| `usage_global`      | `day`                                  | Daily token and request counts across all instances.                                                                           |
| `schema_migrations` | `name`                                 | Applied migration files and their SHA-256 checksums.                                                                           |

Integrity rules enforced by constraints:

- Corpus rows need `cardinality(access_tags) >= 1`; `tenant_key` defaults to `_`.
- Composite foreign keys tie every row to one instance: a version, document, chunk, message or feedback row cannot reference a row of another instance, and a chunk's `tenant_key` must equal its document's.
- At most one version per instance is `active` (partial unique index). `activated_at` is set exactly for `active` and `retired` versions.
- `embedding_dimensions` must be 1024, matching the column type (ADR 0006).

Indexes on `chunks`: GIN on `tsv`, GIN on `access_tags`, B-tree on `(instance_id, index_version_id, tenant_key)`, and HNSW on `embedding vector_cosine_ops` with `m = 16, ef_construction = 64`.

## Access context

Policies read four transaction-local settings through helper functions:

| Setting           | Function                    | Value                                      |
| ----------------- | --------------------------- | ------------------------------------------ |
| `rag.instance_id` | `rag.current_instance()`    | Instance ID                                |
| `rag.tenant_key`  | `rag.current_tenant()`      | Tenant key, `_` when there is no tenant    |
| `rag.access_tags` | `rag.current_access_tags()` | Comma-separated tags, returned as `text[]` |
| `rag.owner_key`   | `rag.current_owner()`       | Conversation owner key                     |

An unset or empty setting returns NULL. A comparison with NULL is never true, so a missing setting returns no rows instead of all rows. The functions are `STABLE` and pin `search_path = pg_catalog`.

## Policies

Every policy names its role, so a role without a policy on a table sees nothing there, the owner included.

| Table                          | `rag_runtime`                                                                        | `rag_ingest`                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `instances`                    | read own instance                                                                    | read and insert own instance                                                                                                    |
| `index_versions`               | read own instance                                                                    | read; insert as `building`; update only while `building` or `ready`, and not to `active` or `retired`; delete when not `active` |
| `documents`, `chunks`          | read where instance matches, `tenant_key` is equal and `access_tags` overlap (below) | read own instance; insert only into a `building` version                                                                        |
| `eval_runs`, `embedding_cache` | none                                                                                 | read and write own instance                                                                                                     |
| `conversations`, `messages`    | read and write where instance and `owner_key` match                                  | none                                                                                                                            |
| `feedback`, `usage_counters`   | read and write own instance                                                          | none                                                                                                                            |
| `usage_global`                 | read and write when any instance context is set                                      | none                                                                                                                            |

The corpus policy, as in ADR 0003:

```sql
instance_id = rag.current_instance()
AND tenant_key = rag.current_tenant()
AND access_tags && rag.current_access_tags()
```

Tenants match by equality and tags by overlap, so a north user holding `faq` never sees a south document tagged `faq`.

Because corpus rows can only be inserted into a `building` version, a version is immutable once it is `ready`. Rolling back serves exactly what was evaluated.

## Roles

| Role           | Login | Purpose                                                                                    |
| -------------- | ----- | ------------------------------------------------------------------------------------------ |
| `rag_migrator` | no    | Owns the schema and every object in it. Migrations run as this role.                       |
| `rag_runtime`  | yes   | The server. Reads the corpus; writes conversations, messages, feedback and usage counters. |
| `rag_ingest`   | yes   | Training. Writes the corpus and executes `rag.activate_index_version`.                     |

All three are `NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION`. Neither login role is a member of any role or has members. Column grants limit updates: `rag_runtime` can update only `conversations.expires_at` and the counter columns; `rag_ingest` can update only `status`, `document_count` and `chunk_count` on `index_versions`, and cannot update `instances` at all.

`verifyRuntimeRole(pool)` fails closed with a `ChatbotError` unless the pool logs in as `rag_runtime` with none of the rights above, no `CREATE` on the database or on schemas `public` and `rag`, and every `rag` table under forced RLS. Calling it at server boot is planned with the HTTP server (ADR 0003).

## Activating an index version

`rag.activate_index_version(instance_id, version_id)` is the only way to change the served version. It is `SECURITY DEFINER` with `search_path = pg_catalog, rag`, and only `rag_ingest` can execute it. It:

1. Requires `instance_id` to equal the caller's `rag.instance_id` setting.
2. Locks the instance row, so concurrent activations of one instance run one after the other.
3. Accepts a `ready` version, or a `retired` one for rollback.
4. Marks the active version `retired`, the new one `active`, and moves `instances.active_index_version_id`.
5. Returns the previously active version ID, or NULL.

The function runs as `rag_migrator`, which forced RLS also restricts. Two policies give `rag_migrator` access to `instances` and `index_versions` of the current instance only.

Not enforced by the function: the eval gate and keeping only the last three versions (ADR 0002). Both belong to `ragctl activate` and `ragctl train` (planned).

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
3. Creates the `vector` extension in schema `public`, revokes `CREATE` on `public` from `PUBLIC`, and creates schema `rag` owned by `rag_migrator`. These steps need administrator rights, which is why they are not in the migration files: pgvector is not a trusted extension.
4. Switches to `rag_migrator` and applies each pending file in name order, recording its SHA-256 checksum.

It refuses to run when an applied file is missing or its checksum changed, when a new file sorts before an applied one, or when two files share a number. Never edit an applied migration; add a new one. A migration that drops or recreates a corpus table must say so in its PR and release notes (ADR 0007).

The administrator in `DATABASE_ADMIN_URL` needs to create roles, create the extension and change privileges on schema `public`. The Docker Compose superuser and the CI service container meet this.

## Trust boundary

As in ADR 0003: whoever holds the `rag_runtime` credential can set the session variables to any instance, tenant or tags. RLS protects against a missing or wrong filter in trusted server code; it does not authenticate anyone. Identity is verified before the transaction starts, and nothing in a request body or URL becomes an access setting without that check.

## What the tests prove

Integration tests in `packages/server/test/integration` run against PostgreSQL with pgvector in CI:

- migrations apply, re-run without changes, and refuse a modified applied file;
- the three roles have no superuser, `BYPASSRLS`, inheritance or role-management rights, and `verifyRuntimeRole` rejects the admin and ingest credentials;
- every `rag` table has forced RLS and is owned by `rag_migrator`; every `rag` function pins `search_path`;
- instance A cannot read instance B's documents or chunks;
- a north user with tag `faq` cannot see a south chunk tagged `faq`; tags match on overlap; empty or unknown tags see nothing;
- a missing or incomplete access context returns zero rows, including on a reused connection;
- the HNSW index returns the nearest chunk the caller may see, not a closer one from another instance or tenant;
- `rag_runtime` cannot write the corpus or execute activation; `rag_ingest` can write only into a `building` version and cannot activate without the function;
- activation moves the pointer and retires the previous version; rollback to a retired version works; building, already active, foreign-instance and mismatched-context activations are refused;
- conversations and messages are visible only to their owner.

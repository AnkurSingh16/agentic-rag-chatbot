# Local setup

This page gets you from a fresh clone to a trained demo instance in a local PostgreSQL database. Everything runs offline with the `fake` embedding provider; no API keys are needed.

> Status: storage, training and `ragctl` are implemented. The HTTP server, retrieval, the agent graph and the evaluation harness are planned, so a trained instance cannot answer questions yet.

## Prerequisites

- Node 24 and npm (`.nvmrc` pins the version).
- Docker with Docker Compose, for PostgreSQL 17 with pgvector. Any PostgreSQL 16 or 17 server with the `vector` extension installed also works if you point the URLs below at it.

## 1. Install and build

```bash
npm install
npm run build
```

`ragctl` runs from the built packages, so build again after changing code. Until the first build, `npx ragctl` prints `ragctl is not built yet`.

## 2. Configure `.env`

```bash
cp .env.example .env
```

Fill in:

| Variable               | Value                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`    | Any password for the local `rag_admin` superuser that Docker Compose creates.                 |
| `RAG_RUNTIME_PASSWORD` | 16 to 256 characters. The migration runner creates `rag_runtime` with it.                     |
| `RAG_INGEST_PASSWORD`  | 16 to 256 characters, different from the runtime password. Used for `rag_ingest`.             |
| `DATABASE_ADMIN_URL`   | `postgres://rag_admin:<POSTGRES_PASSWORD>@127.0.0.1:5432/rag`                                 |
| `DATABASE_URL`         | `postgres://rag_runtime:<RAG_RUNTIME_PASSWORD>@127.0.0.1:5432/rag`                            |
| `DATABASE_INGEST_URL`  | `postgres://rag_ingest:<RAG_INGEST_PASSWORD>@127.0.0.1:5432/rag`. `ragctl` trains through it. |
| `EMBEDDING_PROVIDER`   | `fake`. It is the only provider `ragctl` supports so far; `voyage` and `ollama` are planned.  |

`.env` is git-ignored. `ragctl` and `npm run db:migrate` read it from the current directory, and variables already set in your shell take precedence. Run the commands below from the repository root.

## 3. Start PostgreSQL

```bash
docker compose up -d
```

It listens on `127.0.0.1:5432` only and keeps its data in the `rag-postgres` volume.

## 4. Create the schema

```bash
npm run db:migrate
```

or, equivalently:

```bash
npx ragctl migrate
```

Both create the `rag_migrator`, `rag_runtime` and `rag_ingest` roles if they are missing and apply the migrations in `packages/server/db/migrations`. Running them again changes nothing. Details: [Data model](../architecture/data-model.md#migrations).

## 5. Train the demo instance

`instances/demo` is a public instance with eight synthetic help articles for "Lumen Notes", a note-taking app that does not exist.

```bash
npx ragctl train demo
```

```text
Loaded 8 documents, 25 chunks
Embedded 25 of 25 new chunks
Version 569a901a-1da4-4062-846e-8505456c1d77 is ready
Trained demo: version 569a901a-1da4-4062-846e-8505456c1d77 is ready
  documents 8, chunks 25 (25 embedded, 0 reused from cache)
```

Version IDs differ on every run. Train again without changing a document and every chunk is reused from the embedding cache (`0 embedded, 25 reused from cache`).

## 6. List versions

```bash
npx ragctl versions demo
```

```text
VERSION                               STATUS  EMBEDDING          DOCS  CHUNKS  EVAL  CREATED (UTC)        ACTIVATED (UTC)
569a901a-1da4-4062-846e-8505456c1d77  ready   fake/fake-hash-v1  8     25      none  2026-11-11 08:31:34  -
```

Add `--json` for machine-readable output.

## 7. Activate a version

A version is served only once it is activated, and activation is gated on evaluation ([ADR 0002](../adr/0002-instances-and-index-versions.md)): the version's latest eval run must have passed, using the same embedding provider and model the version was built with.

```bash
npx ragctl activate demo <versionId>
```

The evaluation harness that records eval runs is planned (phase 3), so for now every version reports `it has no eval run` and activation needs `--force` with a reason:

```bash
npx ragctl activate demo <versionId> --force --reason "local demo, no eval harness yet"
```

The forced activation is written to stderr as a JSON event with your user name and the reason. To roll back, activate the previous version, which is now `retired`. See [Create an instance](../guides/create-an-instance.md#7-activate-and-roll-back).

## 8. Run the integration tests (optional)

The integration tests create roles and rows in the database they are given, so use a separate database you can throw away:

```bash
docker compose exec postgres createdb -U rag_admin rag_test
export TEST_DATABASE_ADMIN_URL=postgres://rag_admin:<POSTGRES_PASSWORD>@127.0.0.1:5432/rag_test
export TEST_DATABASE_URL=postgres://rag_runtime:<RAG_RUNTIME_PASSWORD>@127.0.0.1:5432/rag_test
export TEST_DATABASE_INGEST_URL=postgres://rag_ingest:<RAG_INGEST_PASSWORD>@127.0.0.1:5432/rag_test
npm run test:integration
```

Roles are shared by every database in the server, so the test URLs must use the same role passwords as `.env`.

## Stopping and resetting

- `docker compose stop` stops PostgreSQL and keeps the data.
- `docker compose down -v` removes the container and the `rag-postgres` volume, deleting every instance, version and role. Run `npm run db:migrate` again afterwards.

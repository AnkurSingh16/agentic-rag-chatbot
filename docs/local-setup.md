# Local setup

This page gets you from a fresh clone to a chat widget answering questions about the demo instance, first in mock mode with no API key, then optionally in live mode against Claude.

> Status: the chat API (`apps/server`), the web demo (`apps/web-demo`), hybrid retrieval, the agent graph, the retrieval eval harness and `ragctl` are implemented for `public` instances. `authenticated` and `rbac` instances are refused at server start until phase 5. The mock chat model and mock embeddings are deterministic stand-ins, not models.

## Prerequisites

- Node 24 and npm (`.nvmrc` pins the version). On Linux, run `export npm_config_onnxruntime_node_install=skip` before `npm install` so the embedding runtime does not download CUDA libraries; macOS needs nothing.
- Docker with Docker Compose, for PostgreSQL 17 with pgvector. Any PostgreSQL 16 or 17 server with the `vector` extension also works: point the database URLs at it and set `DEV_SKIP_DOCKER=1`.
- Internet access on the first run, to download the local embedding model (about 90 MB) from Hugging Face. Use [offline mode](#offline-mode) if you have none.

## Ports

If a port is taken, `npm run dev` and `npm run dev:ollama` stop before starting and name the settings to change. Put `PORT=4101` and `WEB_DEMO_PORT=5181`, for example, in `.env`, and add `http://127.0.0.1:5181` to `allowedOrigins` in `instances/demo/instance.yaml`.

The chatbot uses its own local ports so it can run next to another project, such as Aegis AI, which uses 5432, 4000 and 5173:

| Service    | Port | Change with                                                   |
| ---------- | ---- | ------------------------------------------------------------- |
| PostgreSQL | 5433 | `RAG_POSTGRES_PORT`, plus the port in the three database URLs |
| Chat API   | 4100 | `PORT` (`VITE_CHAT_API_URL` follows it unless set)            |
| Web demo   | 5180 | `WEB_DEMO_PORT`, plus the instance's `allowedOrigins`         |

## First run in mock mode

```bash
npm install
cp .env.example .env
```

Fill in the database settings in `.env`:

| Variable               | Value                                                                             |
| ---------------------- | --------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`    | Any password for the local `rag_admin` superuser that Docker Compose creates.     |
| `RAG_RUNTIME_PASSWORD` | 16 to 256 characters. The migration runner creates `rag_runtime` with it.         |
| `RAG_INGEST_PASSWORD`  | 16 to 256 characters, different from the runtime password. Used for `rag_ingest`. |
| `DATABASE_ADMIN_URL`   | `postgres://rag_admin:<POSTGRES_PASSWORD>@127.0.0.1:5433/rag`                     |
| `DATABASE_URL`         | `postgres://rag_runtime:<RAG_RUNTIME_PASSWORD>@127.0.0.1:5433/rag`                |
| `DATABASE_INGEST_URL`  | `postgres://rag_ingest:<RAG_INGEST_PASSWORD>@127.0.0.1:5433/rag`                  |

Leave `ANTHROPIC_API_KEY` empty. Every other variable has a working default; `.env.example` describes each one. `.env` is git-ignored.

Then:

```bash
npm run dev
```

`npm run dev` (`scripts/dev.mjs`):

1. starts PostgreSQL with `docker compose up -d --wait` (skipped with `DEV_SKIP_DOCKER=1`);
2. builds every workspace and applies the migrations;
3. if the `demo` instance has no active index version, or its active version was built with a different embedding provider, runs `ragctl train demo`, `ragctl eval demo` and `ragctl activate demo`;
4. starts the API on `http://127.0.0.1:4100` and the web demo on `http://127.0.0.1:5180`, with `LLM_PROVIDER=mock`.

Press Ctrl+C to stop both.

## What you'll see

The first run prints the training and eval output, for example:

```text
Loaded 8 documents, 25 chunks
Embedded 25 of 25 new chunks
...
Version <id>: recall@8 1.00 (minimum 0.60), unanswerable questions with no retrieval 0/2. Eval passed.
Activated <id> for demo. Previous: none.
```

The figures above were measured with `EMBEDDING_PROVIDER=mock`; the local model gives different numbers. Later runs print `Serving demo version <id>` and skip training.

Open `http://127.0.0.1:5180`, click **Chat** and ask "How long does it take for changes to sync?". In mock mode the answer is built from the first sentence of each of the top two retrieved chunks, with a citation after each paragraph and the sources listed below it. Greetings such as "hi" get a fixed reply without retrieval. The mock model never calls a network service.

`demo` is a public instance with eight synthetic help articles for "Lumen Notes", a note-taking app that does not exist.

The API can also be called directly:

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:4100/v1/instances/demo/session | node -p 'JSON.parse(require("fs").readFileSync(0)).token')
curl -N -X POST http://127.0.0.1:4100/v1/instances/demo/chat \
  -H 'content-type: application/json' -H "x-session-token: $TOKEN" \
  -d '{"message":"How long does it take for changes to sync?"}'
```

The response is a server-sent event stream (`meta`, `status`, `token`, `citation`, `final`; see [ADR 0005](adr/0005-agent-graph-streaming-and-guards.md)). Send `accept: application/json` to get one JSON object instead.

## Live mode

Live mode sends questions to Claude through the official Anthropic SDK. It is billed by Anthropic per request, separately from any Claude subscription ([ADR 0008](adr/0008-model-access-and-cost-controls.md)).

1. Create an API key in the Anthropic Console and set a monthly spend limit for it there. The limits in `instance.yaml` cap requests per instance; the Console limit caps the bill.
2. Put the key in this project's `.env` as `ANTHROPIC_API_KEY=...`. Do not export it from a shell profile: `npm run dev:live` reads the key from `.env` only and refuses to start without it there.
3. Set `SESSION_SECRET` in `.env` to at least 32 random characters. The server refuses to start in live mode, with `NODE_ENV=production` or on a non-loopback `HOST` without it. Generate one with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. Run:

   ```bash
   npm run dev:live
   ```

The model is `claude-haiku-5-5` unless `LLM_MODEL` or the instance's `models.chat` names another, for example `claude-sonnet-5-5`.

Each model call writes one log line without message text, for example (values illustrative):

```json
{
  "event": "model_call",
  "instance": "demo",
  "node": "answer",
  "provider": "anthropic",
  "model": "claude-haiku-5-5",
  "inputTokens": 412,
  "outputTokens": 96,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0
}
```

A turn makes up to three calls: `route` (classify the question and write search queries), `answer`, and one `answer` retry when the first answer fails verification. `cacheReadTokens` above zero means the system prompt or the retrieved context was served from the prompt cache. Prompts shorter than the model's minimum cacheable length are not cached, so short demo prompts show zero. The tokens are also added to the daily counters in `rag.usage_counters`.

The limits per instance (`limits` in `instance.yaml`, see [instance.yaml reference](reference/instance-config.md)) default to 512 output tokens per call, 20 turns per session, 20 requests per minute per IP, 100 requests per day per IP and 500 per day per instance. The per-minute limit is kept in each server process's memory; the daily limits are kept in PostgreSQL.

## Free local model (Ollama)

Ollama runs an open model on this Mac and costs nothing per request. I use it for development and demos. Public instances stay on Anthropic unless a self-hosted model is approved later ([ADR 0008](adr/0008-model-access-and-cost-controls.md)).

1. Install Ollama and start its background service:

   ```bash
   brew install ollama
   brew services start ollama
   ```

2. Pull the model. The default depends on memory. Check yours with `sysctl hw.memsize`: 16 GB (17179869184 bytes) or more uses `qwen2.5:7b`; less uses `llama3.2:3b`.

   ```bash
   ollama pull qwen2.5:7b
   ```

   For a machine with less memory, pull `llama3.2:3b` instead.

3. Leave `OLLAMA_MODEL` empty in `.env` to use the default for your memory, or set it to the model you pulled. `OLLAMA_BASE_URL` defaults to `http://127.0.0.1:11434`.

4. Run:

   ```bash
   npm run dev:ollama
   ```

The script checks that Ollama answers at `OLLAMA_BASE_URL` and that the model is pulled. If either is missing it prints the command to run and stops before starting the API. Then it starts the API with `LLM_PROVIDER=ollama`, so no Anthropic key is read or used. Embeddings still run locally with all-MiniLM-L6-v2, so `npm run dev:ollama` trains and evaluates the demo the same way `npm run dev` does.

Measured on this Mac (16 GB, qwen2.5:7b, Q4_K_M quantisation): {MEASURED}

Things to know:

- Only a loopback `OLLAMA_BASE_URL` is accepted unless `OLLAMA_ALLOW_REMOTE=true`, so prompts and documents stay on the machine by default.
- Small models are less reliable at tool calls. When the model does not call the routing tool, or calls it with invalid input, the question goes to retrieval as a knowledge question. Answers still come only from the documents, but routing is less precise than with Claude.
- Ollama has no forced tool choice, so the `route` tool is offered but not required.
- A response cut off by the output token limit is not flagged: Ollama reports it in `done_reason`, and the client does not read that field yet. Verification still rejects a paragraph that lacks a citation, but a truncated final sentence can reach the reader.
- Answers from a small model cite less reliably. Verification still rejects any paragraph without a valid citation, so a weak answer ends as the instance's fallback rather than as an uncited claim.

## Ingesting documents for an instance

To train an instance from a folder instead of its configured sources, evaluate the new version and activate it if the eval passes:

```bash
npm run ingest -- --instance demo --source path/to/data
```

Source URIs are relative to the folder's parent, so a folder named `data` produces the same URIs (`data/sync.md`) as the configured source and the instance's `evals.yaml` still matches. A version that fails the eval stays `ready` and is not activated. To create a new instance, see [Create an instance](guides/create-an-instance.md); restart `npm run dev` to serve it.

## Offline mode

```bash
EMBEDDING_PROVIDER=mock npm run dev
```

or set `EMBEDDING_PROVIDER=mock` in `.env`. Mock embeddings are deterministic hash vectors that only reflect shared words; they need no download. An index is served only with the embeddings it was built with, so `npm run dev` retrains the demo instance when you switch provider. CI runs with `LLM_PROVIDER=mock` and `EMBEDDING_PROVIDER=mock`.

The local model is cached in `MODEL_CACHE_DIR` (default `.cache/models`, git-ignored); after the first download it works offline too.

## Integration tests

The integration tests create roles and rows in the database they are given, so use a separate database you can throw away:

```bash
docker compose exec postgres createdb -U rag_admin rag_test
export TEST_DATABASE_ADMIN_URL=postgres://rag_admin:<POSTGRES_PASSWORD>@127.0.0.1:5433/rag_test
export TEST_DATABASE_URL=postgres://rag_runtime:<RAG_RUNTIME_PASSWORD>@127.0.0.1:5433/rag_test
export TEST_DATABASE_INGEST_URL=postgres://rag_ingest:<RAG_INGEST_PASSWORD>@127.0.0.1:5433/rag_test
npm run build && npm run test:integration
```

Roles are shared by every database in the server, so the test URLs must use the same role passwords as `.env`.

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                                                                                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Missing POSTGRES_PASSWORD, ...`                               | `.env` is missing or incomplete. Copy `.env.example` and fill in the database settings.                                                                                                                                                 |
| `Could not load embedding model Xenova/all-MiniLM-L6-v2`       | The first download failed. Check the network, or use `EMBEDDING_PROVIDER=mock`.                                                                                                                                                         |
| Migration `0008_embeddings_384.sql` fails                      | The database holds 1024-dimension indexes from before ADR 0008. Delete the old index versions and embedding cache as an administrator, or remove the volume with `docker compose down -v`, then run `npm run dev` again to retrain.     |
| Chat returns `not_found`                                       | The instance has no active version. Run `npx ragctl versions <id>` and train or activate one.                                                                                                                                           |
| Chat returns `invalid_config` after switching embedding modes  | The active version was built with other embeddings. Retrain with the current `EMBEDDING_PROVIDER` (`npm run dev` does this for `demo`).                                                                                                 |
| Server refuses to start: `does not implement until phase 5`    | An instance uses `authenticated` or `rbac` mode, which the server does not serve yet. Set `INSTANCE_ID` to a public instance or move the other instance out of `INSTANCES_DIR`.                                                         |
| Widget shows "Too many messages" or "daily message limit"      | A limit in `instance.yaml` was reached (`429` with `rate_limited` or `budget_exceeded`). Daily counters reset at 00:00 UTC.                                                                                                             |
| `403` from the API in the browser                              | The page's origin is not in the instance's `allowedOrigins`.                                                                                                                                                                            |
| `npm run dev:ollama` says Ollama is not reachable              | Start it with `brew services start ollama` or run `ollama serve`, then run the command again. Check `OLLAMA_BASE_URL` if you changed it.                                                                                                |
| `npm run dev:ollama` says the model is not pulled              | Run the `ollama pull <model>` command it prints. `ollama list` shows what is installed.                                                                                                                                                 |
| `OLLAMA_BASE_URL points to ... not a loopback address`         | Use a loopback address, or set `OLLAMA_ALLOW_REMOTE=true` if the Ollama server is on another machine you trust.                                                                                                                         |
| Ollama answers are slow on the first question                  | The first request loads the model into memory, which takes several seconds. Later requests reuse it until Ollama unloads it.                                                                                                            |
| `npm run dev:live` says `ANTHROPIC_API_KEY` is missing         | The key must be in this project's `.env`, not in the shell.                                                                                                                                                                             |
| `401` with `invalid_config` in the server log during live mode | Anthropic rejected the key. Check `ANTHROPIC_API_KEY` in `.env`.                                                                                                                                                                        |
| Sessions stop working after a restart                          | Without `SESSION_SECRET` the server signs sessions with a random secret per start (allowed only in mock mode on a loopback host). The web demo gets a new session automatically; set `SESSION_SECRET` to keep sessions across restarts. |
| `SESSION_SECRET is required when ...`                          | Live mode, `NODE_ENV=production` and non-loopback hosts need a fixed secret. Generate one with the command in [Live mode](#live-mode) and add it to `.env`.                                                                             |

## Stopping and resetting

- `docker compose stop` stops PostgreSQL and keeps the data.
- `docker compose down -v` removes the container and the `rag-postgres` volume, deleting every instance, version and role. `npm run dev` recreates and retrains the demo.

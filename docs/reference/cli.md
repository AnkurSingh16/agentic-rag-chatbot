# ragctl reference

`ragctl` manages instances, index versions and the database schema. It lives in `packages/cli` and runs from the built packages, so run `npm run build` after changing code; until then `npx ragctl` prints `ragctl is not built yet`. For a walkthrough, see [Create an instance](../guides/create-an-instance.md).

```text
ragctl <command> [options]
```

Run it from the repository root. It reads `.env` from the current directory if the file exists; variables already set in the shell take precedence.

## Commands

| Command                                                                   | What it does                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `migrate [--allow-remote]`                                                | Apply database migrations                                                                                |
| `init <id>`                                                               | Create `instances/<id>` with a sample config, document and eval set                                      |
| `train <id> [--source <folder>]`                                          | Build a new index version from the instance's sources, or from one folder                                |
| `eval <id> [versionId] [--min-recall <0..1>]`                             | Score retrieval on the instance's eval set and record an eval run                                        |
| `versions <id> [--json]`                                                  | List index versions                                                                                      |
| `activate <id> <versionId> [--force --reason <text>] [--operator <name>]` | Serve a version; requires passing retrieval and chat eval runs unless forced. Every activation is logged |

`<id>` must match `^[a-z][a-z0-9-]{1,39}$` and, for `train` and `eval`, equal the `id` in `instances/<id>/instance.yaml`.

### Options

| Option              | Commands             | Meaning                                                                                                                                                       |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--instances <dir>` | all except `migrate` | Directory holding instance folders, relative to the current directory. Default `instances`.                                                                   |
| `-h`, `--help`      | all                  | Print the usage text to stdout and exit 0. `ragctl`, `ragctl help` and `ragctl --help` do the same; `ragctl` with no command prints it to stderr and exits 1. |
| `--allow-remote`    | `migrate`            | Allow a `DATABASE_ADMIN_URL` host other than `localhost`, `127.0.0.1` or `[::1]`.                                                                             |
| `--source <folder>` | `train`              | Train from this folder instead of the configured sources. Source URIs are relative to the folder's parent, so a folder named `data` keeps `data/...` URIs.    |
| `--min-recall <n>`  | `eval`               | Mean recall@8 a version needs to pass, from 0 to 1. Default `0.6`.                                                                                            |
| `--json`            | `versions`           | Print the versions as a JSON array instead of a table.                                                                                                        |
| `--force`           | `activate`           | Skip the eval gate. Requires `--reason`.                                                                                                                      |
| `--reason <text>`   | `activate`           | Why the gate is skipped, at most 1,000 characters. Only accepted together with `--force`.                                                                     |
| `--operator <name>` | `activate`           | Who is activating, 1 to 128 characters. Default: the `USER` environment variable, or the OS user name when `USER` is not set.                                 |

`versions` accepts `--instances` but does not read the instance folder. `activate` reads the instance folder unless `--force` is given, to compare the configuration with the latest chat eval run. `migrate` accepts only `--allow-remote` and `--help`. Unknown options and unknown commands print an error and the usage text, and exit 1.

### migrate

Creates the `rag_migrator`, `rag_runtime` and `rag_ingest` roles if they are missing and applies pending files from `packages/server/db/migrations`. Prints the applied files, or `Database schema is up to date.` Same as `npm run db:migrate`. Details: [Data model](../architecture/data-model.md#migrations).

### init

Creates `instances/<id>/instance.yaml` (public mode, `local` embedding provider), `data/welcome.md` and `evals.yaml`. Refuses to touch a directory that already exists. Needs no database.

### train

Reads the instance's sources ([Document format](document-format.md)), chunks and embeds them, writes a new version and marks it `ready`. It never activates. Progress goes to stderr; the summary goes to stdout:

```text
Trained demo: version 1d590c2b-ebfc-433a-be0d-f72c9d2452e9 is ready
  documents 8, chunks 25 (25 embedded, 0 reused from cache), embeddings mock/mock-hash-v1
Evaluate it with "ragctl eval demo 1d590c2b-ebfc-433a-be0d-f72c9d2452e9", then activate it with "ragctl activate demo 1d590c2b-ebfc-433a-be0d-f72c9d2452e9".
```

Chunks already in the instance's embedding cache are reused. After a successful run, `ready` and `retired` versions beyond the three newest are deleted and listed as `Deleted old versions: ...`; the active version is never deleted. Embeddings come from the instance's `embedding` block, or from `EMBEDDING_PROVIDER` when it is set (`local` or `mock`). With `--source`, the config hash stored on the version is still the hash of `instance.yaml`.

### eval

Scores retrieval for one version against the instance's `evalSet` and records the result in `rag.eval_runs`, which the activation gate reads. With `--chat`, it also runs the end-to-end refusal check for unanswerable questions: each question goes through a full chat turn three times with Ollama at temperature 0 and seed 1, and passes only if every unanswerable run is refused and answerable questions are answered with a citation on at least 80% of their runs. It needs `LLM_PROVIDER=ollama` and records a separate `chat` run with the model digest. Activation requires the latest retrieval run and the latest chat run to pass (migration 0009). Without `versionId` it uses the newest version that is not `building`. Retrieval runs as `rag_runtime` (`DATABASE_URL`) with public access, so the eval reads the version through the same row-level policies as a public visitor. Recording the run uses `rag_ingest`. Only `public` instances can be evaluated for now; other modes are refused until per-role eval profiles exist. No chat model is called.

- Answerable questions with `sources` score recall@8: the share of their expected source URIs found among the top 8 chunks. The version passes when the mean reaches `--min-recall` (default 0.6).
- Unanswerable questions should retrieve nothing above the minimum score. They are counted and shown but do not decide the result, because a query that shares words with the documents can still pass the score threshold.

The embedding provider and model must match the version's; otherwise it exits 1. It prints one row per question, then a summary. With mock embeddings on the demo instance (rows shortened):

```text
QUESTION              EXPECTED  RECALL  OK   RETRIEVED
sync-delay            answer    1.00    yes  data/sync.md
encryption-algorithm  nothing   -       no   data/getting-started.md, data/sync.md, ...

Version <id>: recall@8 1.00 (minimum 0.60), unanswerable questions with no retrieval 0/2. Eval passed.
```

The eval run stores `harness`, `recallAt8`, `minRecall`, `unanswerableEmpty`, `unanswerable` and `questions` as metrics, with the embedding provider and model. A failing version exits 1 and stays `ready`.

### versions

Lists the instance's versions, newest first, with columns `VERSION`, `STATUS`, `EMBEDDING` (provider/model), `DOCS`, `CHUNKS`, `EVAL` (`none`, `passed` or `failed`, from the latest eval run), `CREATED (UTC)` and `ACTIVATED (UTC)`. With no versions it prints `No index versions for <id>. Run "ragctl train <id>" first.` `--json` prints every field, including the latest eval run's provider and model.

### activate

Makes a `ready` version active, or a `retired` one again to roll back. The previous active version becomes `retired`. Without `--force`, the latest retrieval run and the latest chat run must both have passed, each with the version's own embedding provider and model. The chat run must also have been made with the current instance configuration: `activate` computes a fingerprint of the persona, forbidden topics, verification judge, limits, model names and the route, answer and judge prompts from `instances/<id>/instance.yaml`, and the database refuses a chat run whose fingerprint differs (migration 0010). Change the configuration and the chat check has to be run again. A version with no chat run cannot be activated without `--force`, even if its retrieval run passed. The database enforces the same gate ([ADR 0002](../adr/0002-instances-and-index-versions.md)), and records every activation in `rag.activation_log` with the operator and reason.

On success it prints `Activated <versionId> for <id>. Previous: <versionId> (now retired).` (or `Previous: none.`), with ` without the eval gate` after the instance id when forced. It also writes JSON events to stderr: `index.activation_forced` (operator, reason, and `gate`: why the gate failed, or `passed`) before a forced activation, and `index.activated` (previous version, `forced`, operator) after every activation.

## Environment variables

| Variable                                      | Used by                                 | Meaning                                                                                                         |
| --------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_INGEST_URL`                         | `train`, `eval`, `versions`, `activate` | Connection URL for the `rag_ingest` role                                                                        |
| `DATABASE_URL`                                | `eval`                                  | Connection URL for the `rag_runtime` role; eval retrieval runs under it                                         |
| `DATABASE_ADMIN_URL`                          | `migrate`                               | Administrator connection URL                                                                                    |
| `RAG_RUNTIME_PASSWORD`, `RAG_INGEST_PASSWORD` | `migrate`                               | Passwords for roles the runner creates                                                                          |
| `EMBEDDING_PROVIDER`                          | `train`, `eval`                         | Optional. `local` or `mock`; overrides the instance's `embedding.provider`, with that provider's default model. |
| `MODEL_CACHE_DIR`                             | `train`, `eval`                         | Where the local embedding model is cached. Default `.cache/models`.                                             |
| `RAG_AUTH_MODE__<ID>`                         | `train`, `eval`                         | Optional auth mode override ([Instance configuration](instance-config.md#auth-mode-override))                   |
| `USER`                                        | `activate`                              | Default for `--operator`                                                                                        |

## Exit codes

| Code | Meaning                                                                                 |
| ---- | --------------------------------------------------------------------------------------- |
| 0    | Success                                                                                 |
| 1    | Usage or configuration error, or anything else the operator can fix (message on stderr) |
| 2    | Any other failure, such as a database error or an unreachable URL source                |

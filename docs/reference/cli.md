# ragctl reference

`ragctl` manages instances, index versions and the database schema. It lives in `packages/cli` and runs from the built packages, so run `npm run build` after changing code; until then `npx ragctl` prints `ragctl is not built yet`. For a walkthrough, see [Create an instance](../guides/create-an-instance.md).

```text
ragctl <command> [options]
```

Run it from the repository root. It reads `.env` from the current directory if the file exists; variables already set in the shell take precedence.

## Commands

| Command                                                                   | What it does                                                                           |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `migrate [--allow-remote]`                                                | Apply database migrations                                                              |
| `init <id>`                                                               | Create `instances/<id>` with a sample config, document and eval set                    |
| `train <id>`                                                              | Build a new index version from the instance's sources                                  |
| `versions <id> [--json]`                                                  | List index versions                                                                    |
| `activate <id> <versionId> [--force --reason <text>] [--operator <name>]` | Serve a version; requires a passing eval run unless forced. Every activation is logged |

`<id>` must match `^[a-z][a-z0-9-]{1,39}$` and, for `train`, equal the `id` in `instances/<id>/instance.yaml`.

### Options

| Option              | Commands                                | Meaning                                                                                                                                                       |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--instances <dir>` | `init`, `train`, `versions`, `activate` | Directory holding instance folders, relative to the current directory. Default `instances`.                                                                   |
| `-h`, `--help`      | all                                     | Print the usage text to stdout and exit 0. `ragctl`, `ragctl help` and `ragctl --help` do the same; `ragctl` with no command prints it to stderr and exits 1. |
| `--allow-remote`    | `migrate`                               | Allow a `DATABASE_ADMIN_URL` host other than `localhost`, `127.0.0.1` or `[::1]`.                                                                             |
| `--json`            | `versions`                              | Print the versions as a JSON array instead of a table.                                                                                                        |
| `--force`           | `activate`                              | Skip the eval gate. Requires `--reason`.                                                                                                                      |
| `--reason <text>`   | `activate`                              | Why the gate is skipped, at most 1,000 characters. Only accepted together with `--force`.                                                                     |
| `--operator <name>` | `activate`                              | Who is activating, 1 to 128 characters. Default: the `USER` environment variable, or the OS user name when `USER` is not set.                                 |

`versions` and `activate` accept `--instances` but do not read the instance folder. `migrate` accepts only `--allow-remote` and `--help`. Unknown options and unknown commands print an error and the usage text, and exit 1.

### migrate

Creates the `rag_migrator`, `rag_runtime` and `rag_ingest` roles if they are missing and applies pending files from `packages/server/db/migrations`. Prints the applied files, or `Database schema is up to date.` Same as `npm run db:migrate`. Details: [Data model](../architecture/data-model.md#migrations).

### init

Creates `instances/<id>/instance.yaml` (public mode, `fake` embedding provider), `data/welcome.md` and `evals.yaml`. Refuses to touch a directory that already exists. Needs no database.

### train

Reads the instance's sources ([Document format](document-format.md)), chunks and embeds them, writes a new version and marks it `ready`. It never activates. Progress goes to stderr; the summary goes to stdout:

```text
Trained demo: version 569a901a-1da4-4062-846e-8505456c1d77 is ready
  documents 8, chunks 25 (25 embedded, 0 reused from cache)
Activate it with "ragctl activate demo 569a901a-1da4-4062-846e-8505456c1d77" once it has a passing eval run.
```

Chunks already in the instance's embedding cache are reused. After a successful run, `ready` and `retired` versions beyond the three newest are deleted and listed as `Deleted old versions: ...`; the active version is never deleted. Only the `fake` embedding provider is implemented.

### versions

Lists the instance's versions, newest first, with columns `VERSION`, `STATUS`, `EMBEDDING` (provider/model), `DOCS`, `CHUNKS`, `EVAL` (`none`, `passed` or `failed`, from the latest eval run), `CREATED (UTC)` and `ACTIVATED (UTC)`. With no versions it prints `No index versions for <id>. Run "ragctl train <id>" first.` `--json` prints every field, including the latest eval run's provider and model.

### activate

Makes a `ready` version active, or a `retired` one again to roll back. The previous active version becomes `retired`. Without `--force`, the version's latest eval run must have passed with the version's own embedding provider and model. The database enforces the same gate ([ADR 0002](../adr/0002-instances-and-index-versions.md)), and records every activation in `rag.activation_log` with the operator and reason.

On success it prints `Activated <versionId> for <id>. Previous: <versionId> (now retired).` (or `Previous: none.`), with ` without the eval gate` after the instance id when forced. It also writes JSON events to stderr: `index.activation_forced` (operator, reason, and `gate`: why the gate failed, or `passed`) before a forced activation, and `index.activated` (previous version, `forced`, operator) after every activation.

## Environment variables

| Variable                                      | Used by                         | Meaning                                                                                       |
| --------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------- |
| `DATABASE_INGEST_URL`                         | `train`, `versions`, `activate` | Connection URL for the `rag_ingest` role                                                      |
| `DATABASE_ADMIN_URL`                          | `migrate`                       | Administrator connection URL                                                                  |
| `RAG_RUNTIME_PASSWORD`, `RAG_INGEST_PASSWORD` | `migrate`                       | Passwords for roles the runner creates                                                        |
| `EMBEDDING_PROVIDER`                          | `train`                         | Optional. Must equal the instance's `embedding.provider` when set.                            |
| `RAG_AUTH_MODE__<ID>`                         | `train`                         | Optional auth mode override ([Instance configuration](instance-config.md#auth-mode-override)) |
| `USER`                                        | `activate`                      | Default for `--operator`                                                                      |

## Exit codes

| Code | Meaning                                                                                 |
| ---- | --------------------------------------------------------------------------------------- |
| 0    | Success                                                                                 |
| 1    | Usage or configuration error, or anything else the operator can fix (message on stderr) |
| 2    | Any other failure, such as a database error or an unreachable URL source                |

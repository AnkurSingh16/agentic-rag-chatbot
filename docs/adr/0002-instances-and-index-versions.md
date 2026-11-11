# ADR 0002: Instances and index versions

## Status

Accepted

## Context

An instance is one chatbot: its documents, persona, access mode and allowed origins. Operators need to create one quickly, load ("train") its documents, check quality, and undo a bad data load without downtime. "Training" here means chunking, embedding and indexing documents. No model is fine-tuned.

## Options considered

- **Configuration source.** Git-reviewed YAML read at boot, or an `instance_configs` table written by a deploy command. A table adds a second source of truth; YAML baked into each release is already immutable per deploy.
- **Rollback.** Rebuild from a previous commit, or keep versioned indexes and switch a pointer. Rebuilding re-spends embedding cost and takes minutes.

## Decision

**Configuration.** Each instance lives in `instances/<id>/instance.yaml`, validated by a Zod schema at boot and loaded into an in-memory registry. `INSTANCE_ID` restricts a server to one instance. YAML never contains secrets, only the names of environment variables that hold them. The hash of the validated config is stored on every index version and on every trace.

Schema outline:

| Field                                     | Notes                                                          |
| ----------------------------------------- | -------------------------------------------------------------- |
| `id`                                      | `^[a-z][a-z0-9-]{1,39}$`                                       |
| `displayName`, `persona`                  | `systemPrompt`, `answerStyle`, `outOfScope`, `forbiddenTopics` |
| `models`                                  | chat model; optional cheaper router model                      |
| `embedding`                               | provider and model; dimension must be 1024 (ADR 0006)          |
| `auth`                                    | discriminated union on `mode` (ADR 0003)                       |
| `allowedOrigins`                          | at least one; `*` rejected                                     |
| `limits`                                  | rate limits and token budgets (ADR 0004)                       |
| `theme`, `sources`, `chunking`, `evalSet` | sources: folder, URL list, sitemap or GitHub docs              |

**Index versions.** `ragctl train` creates a version (`building` → `ready`). `ragctl activate` moves `instances.active_index_version_id` in one statement through a `SECURITY DEFINER` function, and marks the previous version `retired`. The last three versions are kept. Activation requires an `eval_runs` record for that version whose embedding provider and model match the version's; `--force` skips the check and is logged with the operator and reason.

**Incremental training.** An `embedding_cache` keyed by `(instance_id, model, content_sha256)` lets unchanged chunks be copied into a new version without re-embedding. The key includes the instance so the cache cannot carry information between instances.

**Runtime check.** The server re-reads each instance's active version (cached for 30 seconds) on every request, and fails closed if its provider, model or dimension differs from the instance's configured embedding provider. A live `activate` therefore cannot cause silent mismatched retrieval.

## Consequences

- Rollback is one command and takes effect within the 30-second cache window.
- Adding an instance is a config change plus `ragctl train`; no migration.
- An eval gate on `fake` embeddings cannot unlock activation of a `voyage` index.

## Dissent

Architect B preferred an `instance_configs` table written by `ragctl deploy`, giving an audit trail inside the database. Rejected for v1 as a second source of truth; the config hash on each index version and trace gives the audit link back to git.

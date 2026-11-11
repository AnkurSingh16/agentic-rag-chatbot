# Create an instance

This guide takes a new chatbot instance from an empty folder to a served index version, and back again with a rollback. It assumes the database is set up as in [Local setup](../local-setup.md) and that you run every command from the repository root. Every command and flag is listed in the [ragctl reference](../reference/cli.md).

> Status: init, training, retrieval evaluation, versions, activation and rollback are implemented, and `apps/server` serves the active version of `public` instances. `authenticated` and `rbac` instances can be trained but are not served until phase 5.

## 1. Create the instance folder

```bash
npx ragctl init support
```

```text
Created /path/to/repo/instances/support
  instance.yaml    public mode, local embeddings
  data/welcome.md  sample document
  evals.yaml       sample eval set

Next: edit instance.yaml, add documents to data/, then run "ragctl train support".
```

The id must match `^[a-z][a-z0-9-]{1,39}$`. `init` refuses to overwrite an existing folder and needs no database.

## 2. Edit `instance.yaml`

Set at least `displayName`, the `persona` and `allowedOrigins`. Every field is described in the [instance.yaml reference](../reference/instance-config.md). Choose the access mode now, because it decides how documents must be tagged in the next step:

| `auth.mode`     | Use it for                                     | Documents                                            |
| --------------- | ---------------------------------------------- | ---------------------------------------------------- |
| `public`        | Anonymous visitors, such as a personal website | All stored as `public`; any other tag fails training |
| `authenticated` | Any signed-in user may read everything         | Untagged documents get `auth.defaultTags`            |
| `rbac`          | Readers differ by role                         | Every document must carry tags, or training fails    |

`embedding.provider: local` runs all-MiniLM-L6-v2 inside Node and downloads it once; set `EMBEDDING_PROVIDER=mock` to train offline with deterministic hash vectors. A version is served only with the embeddings it was built with, so changing provider or model needs a new training run.

## 3. Add documents with access tags

Put `.md`, `.markdown` or `.txt` files under `instances/support/data/` (subfolders are read too), or list pages under a `urls` source. Remove or replace the sample `welcome.md`.

Tag a markdown or text document with front-matter:

```markdown
---
access: [staff]
---

# Refund approvals

Refunds above 500 dollars need a team lead's approval.
```

Tag an HTML page served to a `urls` source with a meta tag:

```html
<meta name="rag-access" content="staff, managers" />
```

A tag must match `^[a-z0-9][a-z0-9._:-]{0,63}$`. In `rbac` mode a role reads a document when it holds `docs:read:<tag>` for one of its tags, so define those permissions in `auth.roles`. The full rules, including titles and defaults per mode, are in [Document format](../reference/document-format.md).

## 4. Write the eval set

`evalSet` in `instance.yaml` names a YAML file of questions the instance should handle. `ragctl eval` runs it against a version (step 6). The format:

```yaml
questions:
  - id: refund-approval
    question: Who approves a refund above 500 dollars?
    answer: A team lead.
    sources: [data/refunds.md]
  - id: unanswerable-salary
    question: What is the CEO's salary?
    answerable: false
```

| Field        | Required                 | Meaning                                                                                                          |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `id`         | yes                      | Unique within the file; matches `^[a-z0-9][a-z0-9-]{0,63}$`                                                      |
| `question`   | yes                      | The question to ask                                                                                              |
| `answerable` | no, default `true`       | `false` for questions the documents cannot answer; the expected result is a refusal                              |
| `answer`     | for answerable questions | A reference answer. Not allowed when `answerable: false`.                                                        |
| `sources`    | no, default `[]`         | Source URIs that should be retrieved and cited, such as `data/refunds.md`. Not allowed when `answerable: false`. |

The file needs at least one question, and unknown fields are rejected. Include a few unanswerable questions so the harness can check that the instance refuses them.

## 5. Train

```bash
npx ragctl train support
```

```text
Loaded 3 documents, 7 chunks
Embedded 7 of 7 new chunks
Version 2f4c0d4e-8a51-4c47-9a0e-3f1b6c2d9e10 is ready
Trained support: version 2f4c0d4e-8a51-4c47-9a0e-3f1b6c2d9e10 is ready
  documents 3, chunks 7 (7 embedded, 0 reused from cache)
Activate it with "ragctl activate support 2f4c0d4e-8a51-4c47-9a0e-3f1b6c2d9e10" once it has a passing eval run.
```

Version IDs and counts differ on every run. Training builds a new version and marks it `ready`; it never changes what is served. Every document is checked before anything is written, so a missing tag in `rbac` mode or a non-public tag in `public` mode fails the run with the list of offending documents and no partial version.

Train again after changing documents. Unchanged chunks are reused from the embedding cache. After each run, `ready` and `retired` versions beyond the three newest are deleted; the active version is always kept.

## 6. List versions

```bash
npx ragctl versions support
```

```text
VERSION                               STATUS  EMBEDDING          DOCS  CHUNKS  EVAL  CREATED (UTC)        ACTIVATED (UTC)
2f4c0d4e-8a51-4c47-9a0e-3f1b6c2d9e10  ready   mock/mock-hash-v1  3     7       none  2026-11-11 09:12:40  -
```

`EVAL` shows the latest eval run of each version: `none`, `passed` or `failed`. Add `--json` for every field.

Evaluate the new version:

```bash
npx ragctl eval support <versionId>
```

It scores recall@8 over the eval set's `sources` and records an eval run that passes at a mean recall of 0.6 or more (`--min-recall` changes the threshold). See the [ragctl reference](../reference/cli.md#eval).

## 7. Activate and roll back

Activation is gated on evaluation ([ADR 0002](../adr/0002-instances-and-index-versions.md)): the version's latest eval run must have passed, using the same embedding provider and model the version was built with. The database enforces the gate, so `--force` is the only way past it.

```bash
npx ragctl activate support <versionId>
```

Without a passing eval run this fails with exit code 1 and a message such as `Error: Index version <versionId> cannot be activated: it has no eval run.` To activate anyway, give a reason:

```bash
npx ragctl activate support <versionId> --force --reason "eval set not written yet; reviewed answers by hand"
```

```text
Activated <versionId> for support without the eval gate. Previous: none.
```

Every activation, forced or not, is recorded in `rag.activation_log` with the operator and the reason, and written to stderr as JSON events. The operator is your `USER`; pass `--operator <name>` to record someone else, for example a release job.

The gate prevents accidental activation, not deliberate misuse: anyone holding the `rag_ingest` credential can also record an eval run. This is the same trust boundary as in [ADR 0003](../adr/0003-access-modes-and-row-level-security.md).

To roll back, activate the previous version. It is `retired` now, and the version you leave becomes `retired`:

```bash
npx ragctl versions support
npx ragctl activate support <previousVersionId>
```

A rollback passes through the same gate, so a retired version without a passing eval run needs `--force --reason` too. Only the three newest `ready` or `retired` versions survive the next training run, so roll back before training again if you need an older one. Activation log rows remain after their version is deleted.

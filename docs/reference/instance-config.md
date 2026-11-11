# instance.yaml reference

Each chatbot instance is configured by `instances/<id>/instance.yaml`. The server validates it at boot with the Zod schema in `packages/core/src/config/schema.ts` and refuses to start if it is invalid. The design is in [ADR 0002](../adr/0002-instances-and-index-versions.md), with access modes in [ADR 0003](../adr/0003-access-modes-and-row-level-security.md), limits in [ADR 0004](../adr/0004-public-mode-sessions-and-cost-controls.md) and retrieval settings in [ADR 0006](../adr/0006-retrieval-and-embeddings.md).

> Status: implemented. `ragctl` and `apps/server` read this file; the server refuses `authenticated` and `rbac` instances until phase 5.

## Rules that apply to the whole file

- Unknown keys are rejected, except inside `auth`, where fields the selected mode does not use are dropped (see [Auth mode override](#auth-mode-override)). A misspelt field fails boot instead of being ignored.
- The file never contains secrets. API keys and signing secrets are read from environment variables by the server.
- Errors name the field, for example `Invalid instance config: auth.issuer: Invalid URL`. All failing fields are reported at once.
- `loadInstanceConfig` returns the validated config with defaults applied and a `configHash`: the sha256 of the config as JSON with object keys sorted. Key order and explicitly written defaults do not change the hash. It is stored on every index version and trace.

## Fields

| Field                           | Type                                  | Default      | Notes                                                                                                                                                                                                      |
| ------------------------------- | ------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                            | string                                | —            | Required. `^[a-z][a-z0-9-]{1,39}$`. Also names the auth override variable.                                                                                                                                 |
| `displayName`                   | string                                | —            | Required, not blank.                                                                                                                                                                                       |
| `persona.systemPrompt`          | string                                | —            | Required, not blank.                                                                                                                                                                                       |
| `persona.answerStyle`           | string                                | —            | Required, not blank. Tone and length guidance for answers.                                                                                                                                                 |
| `persona.outOfScope`            | string                                | —            | Required, not blank. Refusal text for out-of-scope questions and forbidden topics.                                                                                                                         |
| `persona.forbiddenTopics`       | string[]                              | `[]`         | Topics refused by `guard_out` (ADR 0005).                                                                                                                                                                  |
| `models.chat`                   | string                                | none         | Optional Anthropic model for answers, for example `claude-sonnet-5-5`. Without it the server uses `LLM_MODEL`, then `claude-haiku-5-5` (ADR 0008).                                                         |
| `models.router`                 | string                                | none         | Optional model for the routing call. Defaults to the answer model.                                                                                                                                         |
| `embedding.provider`            | `local` \| `mock`                     | `local`      | `local` runs all-MiniLM-L6-v2 inside Node; `mock` is for tests and offline development. `EMBEDDING_PROVIDER` overrides it (ADR 0008).                                                                      |
| `embedding.model`               | string                                | per provider | `Xenova/all-MiniLM-L6-v2` for `local`, `mock-hash-v1` for `mock`.                                                                                                                                          |
| `embedding.dimensions`          | `384`                                 | `384`        | Any other value is rejected (ADR 0008).                                                                                                                                                                    |
| `auth.mode`                     | `public` \| `authenticated` \| `rbac` | —            | Required. Selects which other `auth` fields are required.                                                                                                                                                  |
| `auth.issuer`                   | https URL                             | —            | Required for `authenticated` and `rbac`. OIDC issuer.                                                                                                                                                      |
| `auth.audience`                 | string                                | —            | Required for `authenticated` and `rbac`.                                                                                                                                                                   |
| `auth.defaultTags`              | string[]                              | —            | Required for `authenticated`, at least one. Access tags every signed-in caller receives.                                                                                                                   |
| `auth.roleClaim`                | string                                | —            | Required for `rbac`. Token claim that holds the caller's roles.                                                                                                                                            |
| `auth.roles`                    | map of role name to permission[]      | —            | Required for `rbac`, at least one role. Role names match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`; `__proto__`, `constructor` and `prototype` are rejected.                                                    |
| `allowedOrigins`                | string[]                              | —            | Required, at least one. Each entry is an exact origin with no path or trailing slash. Must be `https`, except `http` for `localhost`, `127.0.0.1` and `[::1]`. `*` is rejected anywhere in the value.      |
| `limits.maxOutputTokens`        | integer 64–4096                       | `512`        | Output token cap per model call (ADR 0008).                                                                                                                                                                |
| `limits.maxTurnsPerSession`     | integer 1–1000                        | `20`         | Messages one session may send, counted from stored messages. Then `429 rate_limited`.                                                                                                                      |
| `limits.requestsPerMinutePerIp` | integer 1–1000                        | `20`         | Requests to the instance's routes (config, session, chat; preflights excluded) per IP (IPv6 by /64) per minute, counted by `@fastify/rate-limit` in each server process's memory. Then `429 rate_limited`. |
| `limits.dailyRequests`          | integer 1–1000000                     | `500`        | Chat requests per instance per UTC day, counted in PostgreSQL. Then `429 budget_exceeded`.                                                                                                                 |
| `limits.dailyRequestsPerIp`     | integer 1–1000000                     | `100`        | Chat requests per IP per UTC day, checked before the instance cap so one client cannot use it all. Then `429 budget_exceeded`.                                                                             |
| `theme.primaryColor`            | hex colour                            | none         | Optional. `#rgb`, `#rrggbb` or `#rrggbbaa`.                                                                                                                                                                |
| `theme.backgroundColor`         | hex colour                            | none         | Optional.                                                                                                                                                                                                  |
| `theme.textColor`               | hex colour                            | none         | Optional.                                                                                                                                                                                                  |
| `theme.borderRadius`            | length                                | none         | Optional. A number with `px`, `rem` or `em`, for example `8px`. Theme values reach client CSS, so nothing else is accepted.                                                                                |
| `features.adminApi`             | boolean                               | `false`      | Enables admin and training routes. Rejected for `public` instances.                                                                                                                                        |
| `sources`                       | source[]                              | —            | Required, at least one. See [Sources](#sources).                                                                                                                                                           |
| `chunking.targetTokens`         | positive integer                      | `450`        | Tokens are estimated as characters ÷ 4. Must not exceed `maxTokens`.                                                                                                                                       |
| `chunking.overlapTokens`        | integer ≥ 0                           | `60`         | Must be below `targetTokens`.                                                                                                                                                                              |
| `chunking.minTokens`            | integer ≥ 0                           | `50`         | Must be below `targetTokens`.                                                                                                                                                                              |
| `chunking.maxTokens`            | integer 100–8000                      | `800`        | Never exceeded by a chunk, including its heading prefix (capped at 200 characters).                                                                                                                        |
| `evalSet`                       | string                                | none         | Optional path to the instance's eval questions, run by `ragctl eval`. Activation requires a passing eval run (ADR 0002).                                                                                   |
| `requiredPolicies`              | string[]                              | none         | Optional. Row-level security policy names that must exist before the instance is served (ADR 0007). Lower-case SQL identifiers.                                                                            |

### Permissions

Used in `auth.roles`:

| Permission        | Grants                                                   |
| ----------------- | -------------------------------------------------------- |
| `chat:use`        | Sending messages                                         |
| `docs:read:<tag>` | Reading documents tagged `<tag>` (lower-case access tag) |
| `instance:train`  | Training the instance                                    |
| `instance:admin`  | Admin routes                                             |
| `analytics:read`  | Reading analytics                                        |

Access tags match `^[a-z0-9][a-z0-9._:-]{0,63}$`. How a caller's tags are derived in each mode is described in ADR 0003; `resolveAccessTags` and `resolvePermissions` implement it.

### Sources

Each entry has a `type`:

| `type`    | Fields                                                | Notes                                                               |
| --------- | ----------------------------------------------------- | ------------------------------------------------------------------- |
| `folder`  | `path`                                                | Directory of `.md`, `.markdown` and `.txt` files, read recursively. |
| `urls`    | `urls`: http(s) URL[], at least one                   | Individual pages. Training fetches https URLs only.                 |
| `sitemap` | `url`: http(s) URL                                    | Every page listed in the sitemap.                                   |
| `github`  | `repo` (`owner/name`), `path`, `ref` (default `main`) | Markdown files under `path` at `ref`.                               |

`ragctl train` reads `folder` and `urls` sources. Accepted file and content types, front-matter, the HTML `rag-access` meta tag and the tag defaults per access mode are described in [Document format](document-format.md). `sitemap` and `github` sources pass validation but training rejects them; their loaders are planned.

URL sources are fetched with these limits:

- https only. An `http` URL passes validation but training refuses it.
- Before each request, the host name is resolved and every address must be public. Loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`, `fe80::/10`), unique-local (`fc00::/7`), CGNAT (`100.64/10`), `0.0.0.0/8`, `::1` and the IPv4-mapped IPv6 forms of these are refused.
- At most 3 redirects, each target checked the same way.
- 10 seconds per request, including reading the body, and 2 MiB per document.
- The check and the connection resolve the name separately, so a DNS server that changes its answer between them (DNS rebinding) is not stopped. Only list hosts you trust.

### Chunking

`chunkMarkdown` splits each document on ATX headings (`#` to `######`) first, then packs paragraphs up to `targetTokens` with `overlapTokens` of overlap between consecutive chunks of a section. Headings inside fenced code blocks are ignored. Setext headings (a line underlined with `===` or `---`) are not recognised and stay in the body text.

Each chunk's content starts with its heading path (document title, then enclosing headings, joined with `>`). That prefix is capped at 200 characters: short segments are kept whole and longer ones are shortened with `…`. The full heading path is still returned separately for display. Because of the cap and the 100-token minimum for `maxTokens`, no chunk exceeds `maxTokens`.

## Auth mode override

A deployment can change an instance's auth mode without editing the file by setting `RAG_AUTH_MODE__<ID>`, where `<ID>` is the instance id in upper case with `-` replaced by `_` (for `aegis-ai`: `RAG_AUTH_MODE__AEGIS_AI`). An empty value is ignored.

- Overrides may only tighten access, in the order `public` < `authenticated` < `rbac` (ADR 0003). Loosening (`rbac` to `authenticated`, `rbac` to `public`, `authenticated` to `public`) is rejected and fails boot.
- The override applies only when the file's `auth.mode` is itself one of the three modes. A missing or misspelt mode is reported as a schema error; the override never supplies it.
- The override replaces only `auth.mode`, and the result is validated like any other config. To allow tightening, the `auth` block must already contain the stricter mode's fields, for example `roleClaim` and `roles` in an `authenticated` block that a deployment switches to `rbac`. Fields the effective mode does not use are dropped after validation. Write only the fields of the configured mode unless a deployment needs to tighten it.
- The config hash is computed after the override, so it records the mode actually in effect.

## Boot safety checks

`loadInstanceConfig` runs `assertBootSafe` after validation. It rejects:

- `features.adminApi: true` on a `public` instance;
- an `rbac` instance whose `auth.roles` is empty.

Missing `issuer`, `audience` or `roleClaim` for the modes that need them are schema errors. The remaining checks from ADR 0003 need the database (tags on the active index version, database role attributes, `requiredPolicies`) and will run in the server.

## Example

```yaml
id: portfolio
displayName: Site assistant
persona:
  systemPrompt: You answer questions about the services and articles published on this site.
  answerStyle: Short, factual answers in plain English, with citations.
  outOfScope: I can only answer questions about the services and articles on this site.
  forbiddenTopics:
    - the site owner's current employment status
models:
  chat: claude-sonnet-5-5
  router: claude-haiku-5-5
embedding:
  provider: local
  model: Xenova/all-MiniLM-L6-v2
  dimensions: 384
auth:
  mode: public
allowedOrigins:
  - https://ankursingh16.github.io
  - http://localhost:5173
limits:
  maxOutputTokens: 512
  maxTurnsPerSession: 20
  requestsPerMinutePerIp: 20
  dailyRequests: 500
  dailyRequestsPerIp: 100
theme:
  primaryColor: '#1f6feb'
  backgroundColor: '#ffffff'
  textColor: '#1f2328'
  borderRadius: 8px
features:
  adminApi: false
sources:
  - type: folder
    path: docs
  - type: sitemap
    url: https://ankursingh16.github.io/sitemap.xml
  - type: github
    repo: AnkurSingh16/ankursingh16.github.io
    path: content/articles
    ref: main
chunking:
  targetTokens: 450
  overlapTokens: 60
  minTokens: 50
  maxTokens: 800
evalSet: eval/questions.yaml
```

An `rbac` instance replaces the `auth` block, for example:

```yaml
auth:
  mode: rbac
  issuer: https://login.example.com/
  audience: aegis-chatbot
  roleClaim: roles
  roles:
    member:
      - chat:use
      - docs:read:faq
    staff:
      - chat:use
      - docs:read:faq
      - docs:read:internal
      - analytics:read
    operator:
      - instance:train
      - instance:admin
requiredPolicies:
  - aegis_tenant_restrict
```

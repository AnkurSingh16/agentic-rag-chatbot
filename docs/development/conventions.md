# Conventions

## TypeScript

- `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are on. Don't turn them off locally.
- No `any`. Validate untrusted input at the boundary with Zod and work with the inferred types after that.
- Throw `ChatbotError` across package boundaries. Wrap third-party errors with `toChatbotError`.
- Inject dependencies (providers, storage, clocks, `fetch`) instead of importing singletons, so tests stay deterministic.

## Comments and docs

- Comments explain why something is done, not what the code does.
- TSDoc on exported APIs of published packages only.
- Docs use plain technical English. Mark anything planned as planned.

## Tests

- Name tests after the behaviour they prove.
- No real network or model calls in unit and integration tests; use the `fake` providers.
- Security-relevant behaviour (isolation, access modes, prompt injection) always has a test.

## Commits

Conventional Commits, for example `fix(server): reject tokens with the wrong audience`. A body only when the reason isn't obvious from the title.

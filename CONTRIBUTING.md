# Contributing

## Workflow

1. Open or pick an issue. Every PR closes one.
2. Branch from `main` using `feat/`, `fix/`, `chore/`, `docs/` or `test/`.
3. Keep PRs small, ideally under 400 changed lines.
4. Run `npm run check` locally before pushing.
5. Use a [Conventional Commit](https://www.conventionalcommits.org) PR title, for example `feat(retrieval): add RRF merge`. PRs are squash-merged, so the title becomes the commit message.

## Before merge

- CI is green: lint, format, typecheck, tests with coverage thresholds, build, security checks.
- A design review has no open blockers.
- Docs are updated when behaviour, configuration or operations change.
- Coverage does not drop.

## Design changes

Non-trivial design changes need an ADR in `docs/adr`. Copy the format of an existing one.

## Code style

See [docs/development/conventions.md](docs/development/conventions.md).

# Workflow and CI

## Pull requests

Every change reaches `main` through a pull request that closes an issue. PRs are squash-merged, so the PR title must be a Conventional Commit; the `PR title` workflow checks it.

A PR can merge when:

1. All required checks pass.
2. The design review has no open blockers.
3. Docs are updated where behaviour, configuration or operations changed.
4. Coverage has not dropped.

## Workflows

| Workflow       | Runs on                                           | What it does                                                                                                                             |
| -------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`       | PRs, pushes to `main`                             | Lint, format check, typecheck, unit tests with coverage thresholds, build, whitespace check                                              |
| `ci.yml`       | PRs, pushes to `main`                             | PostgreSQL integration tests: migrations and RLS against `pgvector/pgvector:pg17`                                                        |
| `security.yml` | PRs, pushes to `main`, weekly                     | CodeQL, dependency review, gitleaks secret scan, `npm audit` (fails on high)                                                             |
| `pr-title.yml` | PRs                                               | Conventional Commit title check                                                                                                          |
| `claude.yml`   | PRs; comments from the owner mentioning `@claude` | Automated review against the ADRs and the naysayer checklist; skipped until the `ANTHROPIC_API_KEY` secret exists. Not a required check. |

Planned: retrieval evaluation gates, end-to-end tests, docs checks, release and deploy workflows.

## Coverage thresholds

Lines 85%, functions 85%, statements 85%, branches 80%, measured across `packages/*/src`.

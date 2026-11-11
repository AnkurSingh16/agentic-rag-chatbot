# Project rules

Reusable agentic RAG chatbot platform. One server hosts many isolated chatbot instances; each has its own documents, persona and access mode. Consumers so far: Aegis AI and ankursingh16.github.io.

## Stack

Node 24, TypeScript strict, npm workspaces. Fastify 5, Zod, PostgreSQL 17 + pgvector. React 19 + Vite, React Native via Expo. Vitest, Playwright. No other languages or UI frameworks.

## Commands

- `npm run check`: lint, format check, typecheck, tests with coverage, build. Run before every PR.
- `npm test`: unit tests. `npm run test:coverage`: with thresholds.

## Layout

- `packages/core`: retrieval, ingestion, agent graph, provider interfaces. Must not import Fastify, React, React Native or `pg` directly.
- `packages/server`, `client`, `react`, `react-native`, `cli`; `apps/server`, `apps/web-demo`, `apps/mobile-demo`.
- `docs/adr`: every design decision. Read the relevant ADR before changing a design.

## Workflow

1. Meaningful design change: get proposals from `architect-pragmatist` and `architect-scale`, have each critique the other once, merge, then let `naysayer` attack it. Two rounds at most, then decide and record dissent in an ADR.
2. Implementation goes to `implementer`, tests to `test-engineer`, docs to `tech-writer`. One writer at a time unless using separate worktrees.
3. Every PR: small, linked to an issue, Conventional Commit title, `npm run check` green, naysayer review posted with no open blockers, docs updated when behaviour or configuration changes.
4. Skip the debate and extra agents for trivial changes.

## Human approval required

Cloud resources or spend, adding secrets, deploying beyond CI, destructive git or data operations, and any push, PR or merge in another repository. Track waiting items in the pinned "Waiting on Ankur" issue.

## Writing style

- Comments explain why, not what. TSDoc only on exported APIs of published packages. No banner comments or emoji.
- Simple, direct code: no speculative abstractions, no placeholder TODOs.
- Docs and PRs in plain technical English. No marketing words.
- Report test and eval results exactly as measured. Say "production-style", never "production-ready". Separate what is implemented, mocked and planned.
- Never fabricate history or claim work was done differently from how it was done.

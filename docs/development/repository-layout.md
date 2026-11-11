# Repository layout

The repository is an npm workspaces monorepo. Packages under `packages/` are libraries; `apps/` holds deployable or runnable applications.

| Path                    | Depends on                 | Notes                                                                                        |
| ----------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/core`         | nothing framework-specific | Must not import Fastify, React, React Native or `pg`. Storage is reached through interfaces. |
| `packages/server`       | core                       | Fastify plugin and the PostgreSQL storage implementation.                                    |
| `packages/client`       | nothing                    | Runs in browsers and React Native. `fetch` is injected.                                      |
| `packages/react`        | client                     |                                                                                              |
| `packages/react-native` | client                     |                                                                                              |
| `packages/cli`          | core, server storage       |                                                                                              |
| `apps/*`                | the packages above         |                                                                                              |

Shared TypeScript settings live in `tsconfig.base.json`. Each package has a `tsconfig.json` for type-checking (sources and tests) and a `tsconfig.build.json` that emits `dist/`.

Tests sit in each package's `test/` folder and run through the root `vitest.config.ts`, which treats every package as a Vitest project.

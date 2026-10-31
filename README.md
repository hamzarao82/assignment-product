# Typed Task Tracker

A framework-free TypeScript data layer for a task tracker. It behaves correctly when data
is loading, empty, slow, duplicated, stale, malformed, edited concurrently or temporarily
unavailable. No UI framework, database, real backend or runtime dependency.

## Structure

```
src/        types, validation, api, retry, filters, selectors, pagination, store, cache,
            search, emitter, importExport, offlineQueue, audit, conflict, metrics,
            diagnostics, render, stats, equality, timing
tests/      one test file per module, plus scenario.test.ts (the executable demo)
docs/       architecture.md, audit-report.md, coverage-summary.md, demo-script.md,
            learning-log.md, PR text
.github/    CI workflow (runs `npm run verify`) and PR template
```

## Scripts

| Script                  | What it does                                                        |
| ----------------------- | ------------------------------------------------------------------- |
| `npm run lint`          | ESLint with typescript-eslint (no `any`, no `!`, no `as`)           |
| `npm run format:check`  | Prettier, check only                                                |
| `npm run typecheck`     | `tsc --noEmit` with strict, noUncheckedIndexedAccess, exactOptional |
| `npm test`              | Vitest                                                              |
| `npm run test:coverage` | Vitest with coverage gates: 88% lines, 85% branches, 88% functions  |
| `npm run build`         | Emit the library to `dist/`                                         |
| `npm run verify`        | All of the above, in order. CI runs exactly this.                   |

## Where to start reading

1. [docs/architecture.md](docs/architecture.md): state, races, reconciliation, rollback, cache, offline replay.
2. [docs/audit-report.md](docs/audit-report.md): the invariants and the defects found and fixed.
3. [docs/demo-script.md](docs/demo-script.md): the three-minute demo, executable as `tests/scenario.test.ts`.
4. [docs/coverage-summary.md](docs/coverage-summary.md): totals against the gates and per-file coverage.

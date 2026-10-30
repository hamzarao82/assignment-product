# Pull request descriptions (Advanced Extended edition)

Open each as a **Draft**, mark Ready only when local `npm run verify` and CI are green.
The branches are stacked, so merge in order: PR A, then PR B, then PR C.

---

## PR A: `adv/foundation-boundary` (base: `feat/state-and-rendering`)

**Problem solved:** Stricter quality gates, the extended immutable data model and a
trust-boundary validator that rejects what the first iteration accepted.

**Files changed:** `vitest.config.ts`, `package.json` scripts, `.github/workflows/ci.yml`,
`.gitattributes`, `.prettierignore`, `tsconfig.build.json`, `src/types.ts`,
`src/validation.ts`, `tests/types.test.ts`, `tests/validation.test.ts`, `tests/helpers.ts`,
`docs/audit-report.md`.

**Risk / permissions:** None (no I/O). Breaking change: `Task` gains `updatedAt`, `dueAt` and
`version`, so every producer of tasks must supply them.

**Local checks:** `npm run verify` (lint, format:check, typecheck, test:coverage, build).

**Known limits:** `completedAt` can be edited through a patch as well as via toggle; the
server remains the authority on both.

**Final SHA:** `5bc32d3`

**Test evidence:** 189 tests passing; lines 98.28%, branches 94.17%, functions 97.79%.
Reproduced defect V1 (`"March 5, 2024"` accepted as a date) is now a failing-input test.
Property tests: parsed tasks always satisfy the domain invariants; the parsers never throw
on arbitrary input.

---

## PR B: `adv/async-data` (base: `adv/foundation-boundary`)

**Problem solved:** Retry, timeout and cancellation that cannot leak timers; typed filtering,
sorting and memoized selectors; reconciliation-aware pagination with refresh; one shared
fault-isolated emitter.

**Files changed:** `src/retry.ts` (renamed from `fetcher.ts`), `src/api.ts`, `src/metrics.ts`,
`src/filters.ts`, `src/selectors.ts`, `src/emitter.ts`, `src/pagination.ts` and their tests.

**Risk / permissions:** None. Simulated API only; no network.

**Local checks:** `npm run verify`.

**Known limits:** Superseded loader and search promises settle with `undefined`, which
callers must treat as "ignore".

**Final SHA:** `1c8a7a6`

**Test evidence:** 276 tests passing; lines 98.09%, branches 95.45%, functions 95.95%.
Reproduced then fixed: F1 (`maxAttempts: 0` threw `undefined`), F3 (a synchronous throw left
a dangling timer), A1 (cursor `"10abc"` parsed as 10), FL1 (empty tag selection returned
nothing), P17 (a throwing subscriber left `loadMore()` hanging). Sort stability, nulls-last,
`@ts-expect-error` on invalid fields, abort mid-backoff with `getTimerCount() === 0`, and an
out-of-order race using fake timers are all covered.

---

## PR C: `adv/state-resilience-rendering` (base: `adv/async-data`)

**Problem solved:** The optimistic store with per-task ordering, conflicts and pending state;
cache, search, import and export with a dry run, audit log, offline queue, redacted
diagnostics, and the accessible renderer.

**Files changed:** `src/store.ts`, `src/api.ts` (versioned simulated server), `src/audit.ts`,
`src/conflict.ts`, `src/cache.ts`, `src/search.ts`, `src/importExport.ts`,
`src/offlineQueue.ts`, `src/diagnostics.ts`, `src/render.ts`, `src/stats.ts`, `src/equality.ts`,
their tests, `tests/scenario.test.ts`, and `docs/` (architecture, demo script, learning log).

**Risk / permissions:** None. All user text is escaped in HTML and sanitised in the audit
trail; diagnostics redact titles, tags, ids and error messages.

**Local checks:** `npm run verify`.

**Known limits:** Offline replay is at-least-once; a lost acknowledgement surfaces as a
version conflict. Pair the store with the queue using `mutationTimeoutMs: Infinity`.

**Final SHA:** `850c061 (last code commit)`

**Test evidence:** 512 tests passing; lines 99.69%, branches 96.68%, functions 99.31%.
Reproduced then fixed: ST5 (same-task edits reached the server out of order), ST11 and ST17
(subscriber faults), S1 and S3 (search hang and sync throw), R1 (blank list on empty
success). Each guard added during review was mutation-checked: deleting the line makes a
named test fail. `tests/scenario.test.ts` runs the whole demo end to end.

# PR descriptions (paste into GitHub, one per PR)

## PR 1: feat/async-state-types -> main (foundations, 3.1-3.3)

Problem solved: Typed Task model, generic AsyncState<T> and an untrusted-input validator.
Files changed: src/types.ts, src/validation.ts, tests/types.test.ts, tests/validation.test.ts, tooling config (.npmrc, vitest versions).
Risk / permissions affected: None, purely typed data layer.
Local checks run: npm run lint, npm run typecheck, npm run test:coverage
Known limits: Validation reports string errors only (no error codes).
Final SHA: <git rev-parse --short HEAD>

Why completedAt is `Date | null`: it records when a task finished (needed for time-to-complete stats), `null` means not done, and it is never `undefined` so a forgotten field is a compile error.

Compile-time proof that a raw string is not a TaskId (verified by `// @ts-expect-error` in tests/types.test.ts):

```ts
const takesId = (id: TaskId): string => id;
takesId("abc"); // error TS2345: 'string' is not assignable to 'TaskId'
```

## PR 2: feat/async-layer -> main (async layer, 3.4-3.6)

Problem solved: Retry/timeout/abort fetching with a stale-response guard, typed filter/sort/group, and de-duplicating pagination.
Files changed: src/api.ts, src/fetcher.ts, src/timing.ts, src/filters.ts, src/pagination.ts and matching tests.
Risk / permissions affected: None, simulated in-memory API only.
Local checks run: npm run lint, npm run typecheck, npm run test:coverage
Known limits: Page failures retry the same cursor only on the next loadMore(); no automatic resume.
Final SHA: <git rev-parse --short HEAD>

De-duplication rule: same id twice -> keep the later createdAt; on a tie keep the first seen.

Compile-time proof that an invalid sort field is rejected (verified by `// @ts-expect-error` in tests/filters.test.ts):

```ts
sortTasks(tasks, "colour", "asc"); // error TS2345: '"colour"' is not assignable to 'keyof Task'
```

## PR 3: feat/state-and-rendering -> feat/async-layer, then main (3.7-3.10)

Problem solved: Optimistic store with rollback, cache with stale-while-revalidate, debounced search, safe HTML rendering and stats.
Files changed: src/store.ts, src/cache.ts, src/search.ts, src/render.ts, src/stats.ts and matching tests.
Risk / permissions affected: None. All user text is HTML-escaped before rendering.
Local checks run: npm run lint, npm run typecheck, npm run test:coverage
Known limits: "Overdue" means an open task older than 7 days (Task has no due date).
Final SHA: <git rev-parse --short HEAD>

Rollback rule: visible state = confirmed tasks + pending mutations replayed in issue order. A failed mutation is removed and state is recomputed, so a rollback arriving after a newer success keeps the newer change.

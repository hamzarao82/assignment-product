# Architecture audit of the first iteration

Method: state the invariants the system must hold, then attack the existing code
against each one. Every defect below was **reproduced with a failing test before any
fix** (the reproductions became the regression tests listed in the last column).

## System invariants

| ID  | Invariant                                                                                  |
| --- | ------------------------------------------------------------------------------------------ |
| I1  | A stale response never replaces newer state.                                               |
| I2  | Every promise a public API returns eventually settles, even if a callback throws.          |
| I3  | Every timer and event listener is released on every exit path (success, error, abort).     |
| I4  | A faulty subscriber can never corrupt or stall the store, loader or search.                |
| I5  | Operations on one task reach the server in issue order; the UI equals confirmed + pending. |
| I6  | All external data (API, import, cache, queue) is validated from `unknown`.                 |
| I7  | No function mutates a Task, an input array or a state snapshot.                            |
| I8  | Hostile text never reaches HTML, diagnostics or audit entries unsafely.                    |

## Defect register (first iteration)

| ID   | Invariant | Defect                                                                                      | Reproduction result               | Fixed in                   |
| ---- | --------- | ------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------- |
| F1   | I2        | `withRetry` with `maxAttempts: 0` ran zero attempts and threw `undefined`                   | op called 0 times                 | retry module               |
| F3   | I3        | An op that throws synchronously left its timeout timer and abort listener behind            | 1 dangling timer                  | retry module               |
| ST5  | I5        | Two updates to one task were sent concurrently, so the server could apply them out of order | UI "second", server "first"       | store (per-task chain)     |
| S1   | I2        | A superseded in-flight search promise never settled if its fetch ignored the abort signal   | promise hung                      | search module              |
| S3   | I2, I4    | A synchronously throwing search fetch became an uncaught error and the promise hung         | unhandled error                   | search module              |
| ST11 | I4        | A throwing subscriber aborted `mutate` before the API call and stranded the pending entry   | API called 0 times                | store (listener isolation) |
| ST17 | I4        | Subscribing one function twice: unsubscribing once removed both subscriptions               | listener never called             | store (subscription ids)   |
| P17  | I2, I4    | A subscriber throwing on the final publish skipped `done()`, so `loadMore()` hung           | promise hung, unhandled rejection | pagination                 |
| A1   | I6        | Cursor `"10abc"` was accepted as `10` (lenient `parseInt`)                                  | page returned                     | api                        |
| FL1  | UX        | `tags: []` returned zero tasks instead of meaning "no tag filter"                           | empty list                        | filters                    |
| V1   | I6        | `"March 5, 2024"` was accepted as an ISO date                                               | `ok: true`                        | validation (this PR)       |
| R1   | UX        | A `success` state holding zero tasks rendered a blank list, which the product brief forbids | `<ul class="task-list"></ul>`     | render                     |

## Gaps found by review (missing scenarios, not crashes)

- Store and loader were disconnected: nothing fed a fetched list into the store, so a
  refresh while mutations were pending had no defined behaviour.
- Retry backoff was uncapped; the simulation had no clock injection, validation-failure
  or timeout outcome.
- No conflict detection: a stale edit would silently overwrite a newer server change.
- No offline behaviour, import/export, audit trail, metrics or redacted diagnostics.
- Accessibility: no landmarks, live regions or labelled controls in the renderer.
- Partial corruption was invisible: `fetchTasks` dropped invalid records without a signal.

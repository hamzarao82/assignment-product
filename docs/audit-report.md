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

## Found in the final release check

A last pass, reading the Advanced spec clause by clause against the code and running the
suite repeatedly, found eleven more gaps. Each was fixed on the branch where it belongs,
and each has a test that fails when the fix is removed (checked by deleting the fix).

| ID  | Spec clause                | Gap                                                                                               | Fix                                                                                   |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| G1  | section 7 PR template      | The template lacked the required "Test evidence" field                                            | Field added                                                                           |
| G2  | 4.6 repeated cursors       | The simulator could not produce a repeated cursor                                                 | `cursorLoop` option; tests for a self-repeat and an A-B-A cycle                       |
| G3  | 4.3 / section 9            | Parsers read inherited properties, so a polluted prototype could supply a field                   | `ownProp` (own properties only) in the task, patch, import and queue parsers          |
| G4  | 4.13 scripts               | ESLint scanned the generated `dist/`, so a second local `verify` run failed                       | `dist` added to the ESLint ignores                                                    |
| G5  | 4.4 "max three attempts"   | A caller could request more than three attempts                                                   | Requests are clamped to 1..3; tests for 3, 4, 10, 1000 and Infinity                   |
| G6  | 4.4 inject the clock       | `fetchTasks` accepted a clock it never read, implying injection that did not exist                | Clock moved to the paged simulator and server, where it is used                       |
| G7  | 4.9 escape import text     | Nothing rendered an import, so that text path was untested                                        | `renderImportPreview` / `renderImportError`, escaped, with property tests             |
| G8  | 4.9 visible focus hooks    | The hook classes existed but nothing made focus visible                                           | `APP_STYLES` (outline on `:focus-visible`, never removed; reduced motion)             |
| G9  | 3 "no function may mutate" | Non-mutation was tested for some functions only, and `Object.freeze` cannot stop `date.setTime()` | Harness with frozen inputs and a Date whose setters throw, over every public function |
| G10 | 9 self-check               | "Would the compiler force a renderer change?" was shown by running code, not by the compiler      | A `@ts-expect-error` test that fails the build if an unhandled variant compiles       |
| G11 | 8 / deliverables           | The coverage report was only a local file                                                         | CI uploads it as an artifact with a job summary; `docs/coverage-summary.md`           |

Stability checks at the end: the full suite passed repeatedly, including under randomised
test order with several seeds, so no test depends on run order or leaks fake timers.

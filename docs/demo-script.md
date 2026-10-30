# Three-minute demo script

Every beat below is an executable test that wires real modules together (no mocks of our
own code). Run the whole demo in one command and read the beat names aloud:

```
npx vitest run tests/scenario.test.ts --reporter=verbose
```

Each beat takes about 15 to 20 seconds: say the line, point at the assertion, move on.

| Time | Beat                           | Say                                                                                                     | Where to point (`tests/scenario.test.ts`)                                                           |
| ---- | ------------------------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 0:00 | 1. Loading, then data          | "While we fetch, the user sees a loading indicator, then every task with priority and status."          | `renderTaskList(...)` contains "Loading tasks…", then the summary "2 tasks, 1 completed, 1 overdue" |
| 0:20 | 2. Empty                       | "No tasks is not a blank screen. It says so and tells the user what to do next."                        | `No tasks yet` and `Add your first task`, and no `<ul class="task-list">`                           |
| 0:40 | 3. Failure and retry           | "When the network fails we retry with backoff, then show a real error with a Retry button."             | `metrics` shows 3 attempts and 2 retries; the page has `data-action="retry"`; pressing it recovers  |
| 1:00 | 4. Race safety                 | "A slow older response arrives after a newer one. It must never overwrite the screen."                  | The old fetch ignores the abort signal on purpose, yet the screen still shows `new-response`        |
| 1:20 | 5. Optimistic update, rollback | "The edit shows instantly as Saving…, then rolls back and announces the failure if the server says no." | `Saving…` while pending, then the original title returns and the alert region has the error         |
| 1:40 | 6. Stale cache                 | "A stale list is served at once while a refresh runs in the background."                                | `list-v1` returned instantly with the fetcher already called again; later reads return `list-v2`    |
| 2:00 | 7. Import dry run              | "An import shows what would change first. Nothing changes until the user confirms."                     | Summary `created 1, updated 1`; the existing list is untouched; `confirmed: false` does nothing     |
| 2:20 | 8. Offline queue               | "Offline, edits are queued and the screen stays optimistic. On reconnect they replay in order."         | `status: "waiting"`, server still `Orig`, then after `setOnline(true)` the server has both edits    |
| 2:40 | 9. Conflict state              | "If someone else edited the same task, we never overwrite. Both versions are shown to choose from."     | `My edit` and `Their edit` both on screen; the server keeps `Their edit` until "Keep mine"          |
| 3:00 | Finale: safe diagnostics       | "A snapshot you can paste into a bug report: counts and statuses, never a title or tag."                | The JSON has `depth` and `withPendingChanges` but no `Confidential` or `secret-tag`                 |

## If asked "how do you know it is safe?"

- Races: the stale-response test uses a fetch that ignores its abort signal, so only the
  request-id guard can pass it. Delete the guard and it fails.
- Escaping: the injection tests tokenise the output and check real attribute names, and a
  property test feeds a hostile alphabet. Delete `escapeHtml` and they fail.
- Conflicts and replay: `docs/architecture.md` explains the rules; each rule has a test that
  fails if its guard line is removed.

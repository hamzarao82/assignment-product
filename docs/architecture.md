# Architecture note

A framework-free TypeScript data layer. Data is loading, empty, slow, duplicated, stale,
malformed, edited concurrently or unavailable, and the code makes each of those cases an
explicit, tested state. The invariants (I1 to I8) and the defects found in the first
iteration are in [audit-report.md](audit-report.md).

## Layers and modules

| Layer          | Modules                                                                               | Job                                                              |
| -------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Domain         | `types`, `validation`, `conflict`, `equality`, `metrics`                              | Shapes, the trust boundary, shared vocabulary. No I/O.           |
| Infrastructure | `api`, `retry`, `timing`, `cache`, `search`, `emitter`, `offlineQueue`                | Talking to the outside world safely: time, failure, cancellation |
| Application    | `store`, `pagination`, `filters`, `selectors`, `importExport`, `audit`, `diagnostics` | State, derived views, data movement, observability               |
| Presentation   | `render`, `stats`                                                                     | HTML strings and numbers, derived from state only                |

Dependencies point downwards only (presentation uses application, application uses
infrastructure and domain). Nothing in the domain layer imports from another layer.

## Trust boundaries

Everything external starts as `unknown` and is validated by `validation.ts` before it
becomes a `Task`: the API payload, imported files, cache entries, a restored offline queue
and every edit passed to the store. `parseTask` collects all problems and returns a typed
`Result`, so the compiler forces callers to check `ok`. Dates must be real ISO-8601 (the
`Date` constructor alone accepts `"March 5, 2024"`), tags are unique, a due date may not
precede creation, and a patch with an unknown key is rejected so a typo cannot silently do
nothing.

## State

`createTaskStore` keeps two things: `confirmed` (what the server accepted) and an ordered
list of `pending` mutations. The visible state is always `confirmed` with every pending
mutation replayed on top, in issue order, through a pure reducer. That single rule makes
optimistic updates, rollback and conflict handling the same operation: change the pending
list and recompute.

- **Optimistic:** the UI changes immediately; per-task `pending` counts drive "Saving…".
- **Confirm:** a settled mutation folds into `confirmed` in global issue order, so list
  order never shuffles.
- **Rollback:** a failed mutation is removed and the state recomputed. A rollback that
  arrives after a newer success on the same task removes only the failed change.
- **Notifications:** `emitter.ts` delivers each state to every subscriber exactly once, in
  order. An update made from inside a listener is queued, not re-entered. Each `subscribe`
  call is independent, an unsubscribed listener is never called again, and a throwing
  listener is reported but cannot stall the store.

## Races

Three different races are handled, each with a different tool:

1. **Stale responses (read side).** `createLatestLoader` gives every load an increasing id
   and aborts the previous request. The id check, not the abort, is what protects the UI,
   because a fetch can ignore its signal and still resolve later. The test uses exactly
   such a fetch, so removing the guard makes it fail.
2. **Search.** `createSearch` collapses keystrokes, aborts older requests and settles every
   superseded promise immediately, so nothing waits on a request that will never be shown.
3. **Write ordering.** API calls for one task are sent strictly one after another
   (per-task chain); calls for different tasks run in parallel. Without this, two edits to
   one task could reach the server out of order and leave it older than the screen.

## Reconciliation

One rule is used for pagination overlap, hydrating a server snapshot and importing a file:
the copy with the **later `updatedAt`** wins; on a tie the **higher `version`** wins; if both
tie, the copy already held is kept. `createdAt` plays no part, because it never changes and
so says nothing about which copy is newer. Position is preserved: a task stays where it was
first seen.

## Conflicts

Every write carries the version the client believes the server holds. A stale write is
refused with `VersionConflictError` carrying the server's copy. The store then makes the
server copy the confirmed copy, records a typed `Conflict` (local and server summaries and
the refused patch) and skips further queued edits to that task until the user chooses
"keep mine" (replay the patch on the new version) or "keep theirs". A refused change is
never forced through and never silently dropped.

One subtlety worth knowing: when a conflict (or a hydrate) syncs a server copy into
`confirmed`, edits to the same task that were already accepted but not yet folded would be
applied a second time and bump the version twice. They are dropped (conflict) or folded
first (hydrate), and each case has a test that fails if the guard is removed.

## Cache

`createCache` serves a fresh entry directly, a stale entry immediately while refreshing in
the background, and fetches on a miss. Time is injected. Concurrent requests for one key
share a promise; a failed promise is removed so the next caller retries. `invalidate`
bumps a per-key generation, so a response that was pending at invalidation reaches its
callers but is never cached, and a new `get` does not join the old request. The cache is
bounded and treats an entry from the future (clock moved backwards) as a miss.
`createTaskListCache` stores text and re-validates from `unknown` on every read, discarding
a corrupted entry and refetching.

## Offline replay

`createQueuedTaskApi` wraps any `TaskApi`. While offline, writes are queued in order and the
store keeps its optimistic view (the call simply has not finished). On reconnect the queue
replays serially with retry. A final failure stops the queue at that operation and exposes
`retry()` and `discard()`; discard rejects with the real error, so a stale queued edit still
reaches the store as a conflict. Going offline mid-request aborts the attempt and replays
it later, which means replay is at-least-once: a lost acknowledgement surfaces as a
conflict rather than a silent double-apply. The serialized queue is validated from `unknown`
on restore. The store must be created with `mutationTimeoutMs: Infinity` when paired with
the queue, otherwise its own timeout would roll the edit back while offline.

## Trade-offs and known limits

- Replay is at-least-once, not exactly-once (see above); idempotent add and delete reduce
  the cost, and conflicts make the rest visible.
- A listener that throws is isolated and reported, not rethrown to the caller. The default
  reporter writes to the console; production use would inject a real one.
- Search and loader promises settle with `undefined` when superseded, which callers must
  treat as "ignore", not as an empty result.
- Storage is in-memory only, by assignment. The same validation boundary would apply to
  persistent storage.

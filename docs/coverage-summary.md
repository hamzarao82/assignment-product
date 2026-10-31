# Coverage summary

Generated from `npm run test:coverage` (v8 provider). Reproduce with that command; the
full HTML/LCOV report is written to `coverage/` and uploaded by CI as the `coverage-report`
artifact on every run.

## Totals against the gates

| Metric     | Result | Gate | Covered     |
| ---------- | ------ | ---- | ----------- |
| Lines      | 99.70% | 88%  | 1005 / 1008 |
| Branches   | 97.07% | 85%  | 829 / 854   |
| Functions  | 99.33% | 88%  | 299 / 301   |
| Statements | 99.49% | n/a  | 1173 / 1179 |

All three gates are enforced in `vitest.config.ts`, so a run below them fails the build.

## Per file

| File                  | Lines   | Branches | Functions | Statements |
| --------------------- | ------- | -------- | --------- | ---------- |
| `src/api.ts`          | 100.00% | 94.73%   | 100.00%   | 100.00%    |
| `src/audit.ts`        | 100.00% | 93.75%   | 100.00%   | 100.00%    |
| `src/cache.ts`        | 100.00% | 96.87%   | 100.00%   | 98.59%     |
| `src/conflict.ts`     | 100.00% | 100.00%  | 100.00%   | 100.00%    |
| `src/diagnostics.ts`  | 100.00% | 100.00%  | 100.00%   | 100.00%    |
| `src/emitter.ts`      | 100.00% | 100.00%  | 100.00%   | 100.00%    |
| `src/equality.ts`     | 100.00% | 100.00%  | 100.00%   | 100.00%    |
| `src/filters.ts`      | 100.00% | 96.38%   | 100.00%   | 100.00%    |
| `src/importExport.ts` | 100.00% | 100.00%  | 100.00%   | 100.00%    |
| `src/metrics.ts`      | 100.00% | 50.00%   | 100.00%   | 100.00%    |
| `src/offlineQueue.ts` | 100.00% | 97.84%   | 100.00%   | 100.00%    |
| `src/pagination.ts`   | 100.00% | 100.00%  | 93.75%    | 98.68%     |
| `src/render.ts`       | 98.07%  | 93.50%   | 100.00%   | 98.24%     |
| `src/retry.ts`        | 100.00% | 100.00%  | 100.00%   | 100.00%    |
| `src/search.ts`       | 100.00% | 100.00%  | 100.00%   | 100.00%    |
| `src/selectors.ts`    | 100.00% | 100.00%  | 100.00%   | 100.00%    |
| `src/stats.ts`        | 100.00% | 90.00%   | 100.00%   | 100.00%    |
| `src/store.ts`        | 99.30%  | 97.54%   | 98.24%    | 98.89%     |
| `src/timing.ts`       | 100.00% | 100.00%  | 100.00%   | 100.00%    |
| `src/types.ts`        | 88.88%  | 83.33%   | 100.00%   | 88.88%     |
| `src/validation.ts`   | 100.00% | 99.11%   | 100.00%   | 100.00%    |

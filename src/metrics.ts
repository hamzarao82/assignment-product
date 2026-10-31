export type CacheMode = "fresh" | "stale" | "miss";

/**
 * Observability port. Modules receive an optional sink and report counts only; they
 * never put user text (titles, tags, error messages) into metrics.
 */
export interface MetricsSink {
  recordAttempt(): void;
  recordRetry(): void;
  recordCache(mode: CacheMode): void;
  recordMutationFailure(): void;
  recordConflict(): void;
  recordRejectedRecords(count: number): void;
  setQueueDepth(depth: number): void;
}

export interface MetricsSnapshot {
  attempts: number;
  retries: number;
  cache: Record<CacheMode, number>;
  mutationFailures: number;
  conflicts: number;
  rejectedRecords: number;
  queueDepth: number;
  maxQueueDepth: number;
}

export function createMetrics(): MetricsSink & { snapshot: () => MetricsSnapshot } {
  let attempts = 0;
  let retries = 0;
  const cache: Record<CacheMode, number> = { fresh: 0, stale: 0, miss: 0 };
  let mutationFailures = 0;
  let conflicts = 0;
  let rejectedRecords = 0;
  let queueDepth = 0;
  let maxQueueDepth = 0;

  return {
    recordAttempt() {
      attempts++;
    },
    recordRetry() {
      retries++;
    },
    recordCache(mode) {
      cache[mode]++;
    },
    recordMutationFailure() {
      mutationFailures++;
    },
    recordConflict() {
      conflicts++;
    },
    recordRejectedRecords(count) {
      if (count > 0) rejectedRecords += count;
    },
    setQueueDepth(depth) {
      queueDepth = Math.max(0, depth);
      maxQueueDepth = Math.max(maxQueueDepth, queueDepth);
    },
    /** Returns a copy, so callers cannot mutate the live counters. */
    snapshot: () => ({
      attempts,
      retries,
      cache: { ...cache },
      mutationFailures,
      conflicts,
      rejectedRecords,
      queueDepth,
      maxQueueDepth,
    }),
  };
}

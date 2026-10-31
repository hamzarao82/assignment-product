export type ErrorReporter = (error: unknown) => void;

/** Listener faults are reported, never thrown into the code that emitted the change. */
export const reportToConsole: ErrorReporter = (error) => {
  console.error("[task-tracker] listener threw:", error);
};

export interface Emitter<T> {
  subscribe(listener: (value: T) => void): () => void;
  emit(value: T): void;
  size(): number;
}

interface Subscription<T> {
  readonly listener: (value: T) => void;
  active: boolean;
}

/**
 * Ordered, fault-isolated delivery:
 *  - every emitted value reaches every subscriber exactly once, in emit order;
 *  - an emit made from inside a listener is queued and delivered after the current
 *    delivery finishes, so no subscriber sees the newest value twice;
 *  - each subscribe() call is its own subscription, so unsubscribing one never removes
 *    another, even for the same function;
 *  - an unsubscribed listener is never called again, even mid-delivery;
 *  - a listener that throws is reported to `onError` and cannot stop other listeners or
 *    leave the emitter in a broken state.
 */
export function createEmitter<T>(onError: ErrorReporter = reportToConsole): Emitter<T> {
  const subscriptions = new Set<Subscription<T>>();
  const queue: { value: T }[] = [];
  let delivering = false;

  function report(error: unknown): void {
    try {
      onError(error);
    } catch {
      // The reporter itself failed; there is nowhere safe left to send the error.
    }
  }

  return {
    subscribe(listener) {
      const subscription: Subscription<T> = { listener, active: true };
      subscriptions.add(subscription);
      return () => {
        subscription.active = false;
        subscriptions.delete(subscription);
      };
    },
    emit(value) {
      queue.push({ value });
      if (delivering) return;
      delivering = true;
      try {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
          for (const subscription of [...subscriptions]) {
            if (!subscription.active) continue;
            try {
              subscription.listener(item.value);
            } catch (error) {
              report(error);
            }
          }
        }
      } finally {
        delivering = false;
      }
    },
    size: () => subscriptions.size,
  };
}

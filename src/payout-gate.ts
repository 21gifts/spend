/**
 * Serialize payout runs in one process (ping queue and CLI share this gate in the HTTP server).
 *
 * @returns Gate whose `run` callbacks execute one after another.
 */
export function createPayoutGate(): {
  run: <T>(fn: () => Promise<T>) => Promise<T>;
} {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = tail.then(fn, fn);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

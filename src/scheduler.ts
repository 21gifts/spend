import { isUtcMidnightWindow } from './utc-window';

/**
 * Poll UTC midnight and run one payout per UTC day.
 *
 * @param opts - Clock, live flag, and run callback.
 * @returns Handle with `stop`.
 */
export function startMidnightScheduler(opts: {
  now?: () => Date;
  live: boolean;
  run: (day: string) => Promise<{ exitCode: number }>;
  intervalMs?: number;
}): { stop: () => void } {
  const now = opts.now ?? (() => new Date());
  const intervalMs = opts.intervalMs ?? 30_000;
  let lastDay: string | null = null;
  let inFlight = false;

  const tick = (): void => {
    const instant = now();
    if (!isUtcMidnightWindow(instant)) {
      return;
    }
    const day = instant.toISOString().slice(0, 10);
    if (lastDay === day || inFlight) {
      return;
    }
    inFlight = true;
    void opts
      .run(day)
      .then((result) => {
        // Retry inside the window on preflight/lock/balance/spot (exit 3).
        // Success (0), config (2), and halt/failed (4) must not re-enter.
        if (result.exitCode !== 3) {
          lastDay = day;
        }
        console.warn(
          JSON.stringify({
            ts: instant.toISOString(),
            event: 'spend.scheduler',
            day,
            live: opts.live,
            exitCode: result.exitCode,
          }),
        );
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'scheduler';
        console.warn(
          JSON.stringify({
            ts: instant.toISOString(),
            event: 'spend.scheduler',
            day,
            live: opts.live,
            error: message,
          }),
        );
      })
      .finally(() => {
        inFlight = false;
      });
  };

  tick();
  const id = setInterval(tick, intervalMs);
  return {
    stop: () => {
      clearInterval(id);
    },
  };
}

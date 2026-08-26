/** First minutes of UTC hour 0 — cron may fire a bit after :00. */
export const UTC_MIDNIGHT_MINUTE_LIMIT = 5;

/**
 * Whether `now` is in the UTC midnight window (hour 0, minute 0–5).
 *
 * macOS cron ignores `CRON_TZ`; schedule hourly and gate here.
 *
 * @param now - Instant to test.
 * @returns True only in that window.
 */
export function isUtcMidnightWindow(now: Date): boolean {
  return now.getUTCHours() === 0 && now.getUTCMinutes() <= UTC_MIDNIGHT_MINUTE_LIMIT;
}

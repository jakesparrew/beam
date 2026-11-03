/**
 * Job retry backoff (PL-26): after failed attempt n (1..5) the next `run_at` is now plus
 * 60 s, 300 s, 900 s, 3600 s or 21600 s, each plus 0-20 % random jitter. When the attempt
 * that failed was the last one (`max_attempts`, default 6) the job is `dead`: `null`.
 */
export const BACKOFF_SECONDS = [60, 300, 900, 3600, 21600] as const;
export const MAX_JITTER = 0.2;
export const DEFAULT_MAX_ATTEMPTS = 6;

/** The delay in milliseconds after failed attempt `attempt`, before jitter. */
export function baseDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`attempt must be an integer >= 1, got ${attempt}`);
  const seconds = BACKOFF_SECONDS[Math.min(attempt, BACKOFF_SECONDS.length) - 1] as number;
  return seconds * 1000;
}

/**
 * The next run time after failed attempt `attempt` (1-based, the value of `jobs.attempts`
 * after the claim), or `null` when the job is out of attempts and turns `dead`.
 * `random` returns a number in [0, 1); it scales the 0-20 % jitter.
 */
export function nextRunAt(
  attempt: number,
  now: Date,
  random: () => number = Math.random,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Date | null {
  if (attempt >= maxAttempts) return null;
  const r = Math.min(Math.max(random(), 0), 1);
  const delay = baseDelayMs(attempt) * (1 + MAX_JITTER * r);
  return new Date(now.getTime() + Math.round(delay));
}

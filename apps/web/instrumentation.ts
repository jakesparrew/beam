/**
 * Next.js instrumentation (runbook DR-13, DR-15): Sentry on the server and, only with
 * `APP_ENV=local` and `LOCAL_TICK_MS` set, the in-process tick that runs the same `runTick()`
 * as `/api/cron/tick` (so `next dev` and the e2e `next start` process jobs without Vercel Cron).
 */
import * as Sentry from "@sentry/nextjs";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await import("./sentry.server.config");
  if (process.env.LOCAL_TICK_MS) {
    const { startLocalTick } = await import("./lib/job-runner");
    // startLocalTick refuses outside APP_ENV=local (preview, staging and production use Vercel Cron).
    startLocalTick();
  }
}

export const onRequestError = Sentry.captureRequestError;

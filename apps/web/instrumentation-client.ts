/**
 * Sentry in the browser (runbook DR-15: `@sentry/nextjs` 11 loads this file; there is no
 * `sentry.client.config.ts`). Without `NEXT_PUBLIC_SENTRY_DSN` the SDK stays off. The scrubbing
 * mirrors `lib/logger.ts` (which uses pino and stays server-only): no request bodies or cookies,
 * emails and phone numbers masked (PL-72).
 */
import * as Sentry from "@sentry/nextjs";
import { scrubEvent } from "./lib/sentry-scrub";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_APP_ENV ?? "local",
    tracesSampleRate: 0.1,
    // Reset and invite tokens sit in the path and magic-link tokens in the query: every URL is scrubbed.
    beforeSend: (event) => scrubEvent(event),
    beforeSendTransaction: (event) => scrubEvent(event),
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

/**
 * Sentry in the browser (runbook DR-15: `@sentry/nextjs` 11 loads this file; there is no
 * `sentry.client.config.ts`). Without `NEXT_PUBLIC_SENTRY_DSN` the SDK stays off. The scrubbing
 * mirrors `lib/logger.ts` (which uses pino and stays server-only): no request bodies or cookies,
 * emails and phone numbers masked (PL-72).
 *
 * The SDK is imported dynamically: this file is part of every page's first-load JavaScript, and
 * a static import put the whole SDK (about 90 KB compressed) into the shared root bundle even
 * without a DSN (site rule 51, first-load budget). With a DSN the SDK loads as its own chunk.
 */
import type * as SentryNamespace from "@sentry/nextjs";

type SentryModule = typeof SentryNamespace;

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
let sentry: SentryModule | null = null;

if (dsn) {
  void Promise.all([import("@sentry/nextjs"), import("./lib/sentry-scrub")]).then(([Sentry, { scrubEvent }]) => {
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_APP_ENV ?? "local",
      tracesSampleRate: 0.1,
      // Reset and invite tokens sit in the path and magic-link tokens in the query: every URL is scrubbed.
      beforeSend: (event) => scrubEvent(event),
      beforeSendTransaction: (event) => scrubEvent(event),
    });
    sentry = Sentry;
  });
}

export function onRouterTransitionStart(...args: Parameters<SentryModule["captureRouterTransitionStart"]>): void {
  sentry?.captureRouterTransitionStart(...args);
}

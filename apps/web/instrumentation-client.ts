/**
 * Sentry in the browser (runbook DR-15: `@sentry/nextjs` 11 loads this file; there is no
 * `sentry.client.config.ts`). Without `NEXT_PUBLIC_SENTRY_DSN` the SDK stays off. The scrubbing
 * mirrors `lib/logger.ts` (which uses pino and stays server-only): no request bodies or cookies,
 * emails and phone numbers masked (PL-72).
 */
import * as Sentry from "@sentry/nextjs";

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+|00)\d[\d\s./-]{7,}\d|\b0\d{1,3}[\s./-]?\d{2,3}[\s./-]?\d{2}[\s./-]?\d{2}\b/g;
const mask = (text: string) => text.replace(EMAIL, "[email]").replace(PHONE, "[phone]");

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_APP_ENV ?? "local",
    tracesSampleRate: 0.1,
    beforeSend(event) {
      if (event.message) event.message = mask(event.message);
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
      }
      for (const v of event.exception?.values ?? []) if (v.value) v.value = mask(v.value);
      for (const b of event.breadcrumbs ?? []) if (b.message) b.message = mask(b.message);
      if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
      return event;
    },
  });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

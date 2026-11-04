/**
 * Sentry for the Node.js server (EU region DSN). Without `SENTRY_DSN` the SDK stays off.
 * `beforeSend` removes request bodies and cookies and masks emails and phones (PL-72).
 */
import * as Sentry from "@sentry/nextjs";
import { scrubSentryEvent } from "./lib/logger";

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.APP_ENV ?? "local",
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: 0.1,
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendTransaction: (event) => scrubSentryEvent(event),
    beforeBreadcrumb: (crumb) => (crumb.category === "console" ? null : crumb),
  });
}

/**
 * Logging and error reporting (PL-72). Logs carry ids only: pino redacts personal fields and
 * credentials. Sentry's `beforeSend` (`scrubSentryEvent`) removes request bodies and cookies and
 * masks email addresses and phone numbers in messages. `reportError()` is the one way runtime
 * code sends an exception to Sentry; tests swap the reporter with `fakeSentry()` (lib/testing.ts).
 */
import * as Sentry from "@sentry/nextjs";
import pino, { type DestinationStream, type Logger } from "pino";

export const REDACT_PATHS = [
  "email",
  "phone",
  "name",
  "first_name",
  "last_name",
  "firstName",
  "lastName",
  "password",
  "token",
  "*.email",
  "*.phone",
  "*.name",
  "*.first_name",
  "*.last_name",
  "*.firstName",
  "*.lastName",
  "*.password",
  "*.token",
  "req.headers.cookie",
  "req.headers.authorization",
  'req.headers["set-cookie"]',
];

export function createLogger(destination?: DestinationStream): Logger {
  const options = {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"),
    base: { app: "beam" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger: Logger = createLogger();

// ---------------------------------------------------------------------------
// Sentry scrubbing
// ---------------------------------------------------------------------------

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// International or Belgian numbers: +32 470 12 34 56, 0470/12.34.56, 0032470123456.
const PHONE = /(?:\+|00)\d[\d\s./-]{7,}\d|\b0\d{1,3}[\s./-]?\d{2,3}[\s./-]?\d{2}[\s./-]?\d{2}\b/g;

/** Masks email addresses and phone numbers in free text. */
export function maskPii(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
}

type ScrubbableEvent = {
  message?: string;
  request?: { data?: unknown; cookies?: unknown; headers?: Record<string, string>; query_string?: unknown };
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: { message?: string }[];
  user?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

/** Sentry `beforeSend`: no request bodies or cookies, emails and phones masked (PL-72). */
export function scrubSentryEvent<E extends ScrubbableEvent>(event: E): E {
  if (event.message) event.message = maskPii(event.message);
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    if (event.request.headers) {
      for (const h of Object.keys(event.request.headers)) {
        if (/^(cookie|authorization|set-cookie)$/i.test(h)) delete event.request.headers[h];
      }
    }
    if (typeof event.request.query_string === "string") event.request.query_string = maskPii(event.request.query_string);
  }
  for (const v of event.exception?.values ?? []) if (v.value) v.value = maskPii(v.value);
  for (const b of event.breadcrumbs ?? []) if (b.message) b.message = maskPii(b.message);
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  return event;
}

// ---------------------------------------------------------------------------
// Error reporting seam
// ---------------------------------------------------------------------------

export type ErrorReporter = {
  captureException(error: unknown, context?: { tags?: Record<string, string>; extra?: Record<string, unknown> }): void;
  captureMessage(message: string, context?: { tags?: Record<string, string>; extra?: Record<string, unknown> }): void;
};

const sentryReporter: ErrorReporter = {
  captureException(error, context) {
    Sentry.captureException(error, context);
  },
  captureMessage(message, context) {
    Sentry.captureMessage(maskPii(message), context);
  },
};

const holder = globalThis as unknown as { __beamReporter?: ErrorReporter };

export function setErrorReporter(reporter: ErrorReporter | undefined): void {
  holder.__beamReporter = reporter;
}

function reporter(): ErrorReporter {
  return holder.__beamReporter ?? sentryReporter;
}

/** Sends an exception to Sentry and logs it (ids only). */
export function reportError(error: unknown, context: { tags?: Record<string, string>; extra?: Record<string, unknown> } = {}): void {
  try {
    reporter().captureException(error, context);
  } catch {
    // Reporting never breaks the caller.
  }
  logger.error({ err: error instanceof Error ? { name: error.name, message: maskPii(error.message) } : String(error), ...context.tags }, "error");
}

export function reportMessage(message: string, context: { tags?: Record<string, string>; extra?: Record<string, unknown> } = {}): void {
  try {
    reporter().captureMessage(message, context);
  } catch {
    // ignore
  }
}

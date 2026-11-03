/**
 * The error classes every layer shares (`@beam/core/errors`).
 *
 * The job runner reads them: a `RetryableError` (and any plain `Error`) is retried with
 * the backoff of PL-26, a `PermanentError` makes the job `dead` at once (PL-28).
 * `action()` maps `ForbiddenError` to the action error code `forbidden`.
 */
import type { Locale } from "./i18n/locales";

/** A failure that may succeed on a later attempt (timeouts, 429, 5xx, a row not committed yet). */
export class RetryableError extends Error {
  override readonly name: string = "RetryableError";
  readonly retryable = true as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A failure that no retry can fix (invalid payload, missing translation, a 4xx from a provider). */
export class PermanentError extends Error {
  override readonly name: string = "PermanentError";
  readonly retryable = false as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A Wave 0 stub or a not yet built adapter was called. Permanent: retrying cannot help. */
export class NotImplementedError extends PermanentError {
  override readonly name: string = "NotImplementedError";
  constructor(what: string) {
    super(`not_implemented: ${what}`);
  }
}

/** The actor lacks a permission, or a purpose is not allowed for it (`ctx.require`, `readSensitive`). */
export class ForbiddenError extends Error {
  override readonly name: string = "ForbiddenError";
  readonly permission: string | null;
  constructor(message = "forbidden", permission: string | null = null) {
    super(message);
    this.permission = permission;
  }
}

/**
 * A `LocalizedText` or a catalogue lacks one or more required locales (PL-64). Permanent,
 * because no retry fills in a translation; send paths mark the message `blocked_translation`.
 */
export class MissingTranslationError extends PermanentError {
  override readonly name: string = "MissingTranslationError";
  readonly missing: Locale[];
  constructor(missing: Locale[], what = "text") {
    super(`missing_translation: ${what} lacks ${missing.join(", ")}`);
    this.missing = missing;
  }
}

/** `t()` found no message for a key (thrown in tests and development; production renders `⟦key⟧`). */
export class MissingMessageError extends PermanentError {
  override readonly name: string = "MissingMessageError";
  readonly key: string;
  readonly locale: Locale;
  constructor(locale: Locale, key: string) {
    super(`missing_message: ${locale} ${key}`);
    this.key = key;
    this.locale = locale;
  }
}

/** True for errors the job runner must not retry. */
export function isPermanentError(error: unknown): error is PermanentError {
  return error instanceof PermanentError;
}

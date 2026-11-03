import { PermanentError } from "@beam/core/errors";
import type { IntegrationProvider } from "./types";

/**
 * A provider call failed. `retryable` decides the job outcome: true -> the job retries with
 * the backoff of PL-26, false -> the job is `dead` (see `isPermanentFailure`).
 */
export class IntegrationError extends Error {
  override readonly name = "IntegrationError";
  readonly provider: IntegrationProvider;
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly operation?: string;
  /** A machine-readable reason, for example `timeout`, `not_configured`, `refusal:<category>`. */
  readonly code?: string;

  constructor(input: {
    provider: IntegrationProvider;
    retryable: boolean;
    message: string;
    statusCode?: number;
    operation?: string;
    code?: string;
    cause?: unknown;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.provider = input.provider;
    this.retryable = input.retryable;
    if (input.statusCode !== undefined) this.statusCode = input.statusCode;
    if (input.operation !== undefined) this.operation = input.operation;
    if (input.code !== undefined) this.code = input.code;
  }
}

/** 408, 425, 429 and every 5xx are retryable; other 4xx are permanent. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** The standard mapping from an HTTP status to an `IntegrationError`. */
export function errorFromStatus(
  provider: IntegrationProvider,
  operation: string,
  status: number,
  detail?: string,
): IntegrationError {
  return new IntegrationError({
    provider,
    operation,
    statusCode: status,
    retryable: isRetryableStatus(status),
    message: `${provider} ${operation} failed with ${status}${detail ? `: ${scrubError(detail)}` : ""}`,
  });
}

/** A network failure (DNS, reset, abort): always retryable. */
export function networkError(provider: IntegrationProvider, operation: string, cause: unknown): IntegrationError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new IntegrationError({ provider, operation, retryable: true, code: "network", message: `${provider} ${operation}: ${scrubError(message)}`, cause });
}

/** True when the job runner must not retry: a `PermanentError` or a non-retryable `IntegrationError`. */
export function isPermanentFailure(error: unknown): boolean {
  if (error instanceof PermanentError) return true;
  if (error instanceof IntegrationError) return !error.retryable;
  return false;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const KEYLIKE = /\b(sk|pk|test|live|re|xoxb|key)_[A-Za-z0-9_-]{8,}\b/g;

/** First 1,000 characters with emails, bearer tokens and key-like strings masked (`integration_calls.error`). */
export function scrubError(text: string): string {
  return text.replace(EMAIL, "[email]").replace(BEARER, "$1[redacted]").replace(KEYLIKE, "[redacted]").slice(0, 1000);
}

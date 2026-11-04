/**
 * Shared integration types (architecture section 8). A client never imports the database:
 * it reports every call through `onCall`, which the job context wires to `ctx.integrationLog`
 * (`integration_calls`: operation, request digest, status code, duration; never bodies).
 */

/**
 * Values of the `integration_calls_provider` enum, in its order: `meta` is crm's unified-inbox
 * Meta messaging API (R3, distinct from `meta_ads`) and `webhook` automation's
 * `automation.call_webhook` step.
 */
export const INTEGRATION_PROVIDERS = [
  "mollie",
  "stripe",
  "viva",
  "billit",
  "resend",
  "youtube",
  "meta_ads",
  "google_ads",
  "anthropic",
  "slack",
  "betterstack",
  "wordpress",
  "meta",
  "webhook",
] as const;

export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

/** One provider call, as `integration_calls` stores it. */
export type IntegrationCallEntry = {
  provider: IntegrationProvider;
  /** `<area>.<verb>`, for example `payments.get`, `messages.create`, `emails.send`. */
  operation: string;
  /** sha256 hex of method, path and sorted non-secret params (`digestRequest`). */
  requestDigest: string;
  statusCode: number | null;
  ok: boolean;
  durationMs: number;
  /** First 1,000 characters, scrubbed; `null` on success. */
  error: string | null;
};

export type OnCall = (entry: IntegrationCallEntry) => void | Promise<void>;

/** An `onCall` that drops entries (tests that do not assert the log). */
export const noopOnCall: OnCall = () => undefined;

/** The `fetch` signature clients accept so tests can inject one (no network in tests). */
export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** A fake's call record, for assertions. */
export type FakeCall<TInput = unknown> = { operation: string; input: TInput; at: Date };

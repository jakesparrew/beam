import { IntegrationError, networkError, scrubError } from "./errors";
import type { IntegrationProvider, OnCall } from "./types";

/**
 * Runs `work` with an `AbortSignal` that fires after `ms`; a timeout rejects with a retryable
 * `IntegrationError` (code `timeout`).
 */
export async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  context: { provider: IntegrationProvider; operation: string },
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject before aborting, so work that settles on abort cannot win the race.
      queueMicrotask(() => controller.abort());
      reject(
        new IntegrationError({
          provider: context.provider,
          operation: context.operation,
          retryable: true,
          code: "timeout",
          message: `${context.provider} ${context.operation} timed out after ${ms} ms`,
        }),
      );
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Times one provider call and reports it through `onCall` (success or failure), then returns
 * the result or rethrows. Non-`IntegrationError` failures become retryable network errors.
 */
export async function trackCall<T>(
  onCall: OnCall,
  meta: { provider: IntegrationProvider; operation: string; requestDigest: string },
  work: () => Promise<{ value: T; statusCode: number | null }> | { value: T; statusCode: number | null },
  now: () => number = Date.now,
): Promise<T> {
  const started = now();
  try {
    const { value, statusCode } = await work();
    await onCall({ ...meta, statusCode, ok: true, durationMs: Math.max(0, now() - started), error: null });
    return value;
  } catch (error) {
    const failure = error instanceof IntegrationError ? error : networkError(meta.provider, meta.operation, error);
    await onCall({
      ...meta,
      statusCode: failure.statusCode ?? null,
      ok: false,
      durationMs: Math.max(0, now() - started),
      error: scrubError(failure.message),
    });
    throw failure;
  }
}

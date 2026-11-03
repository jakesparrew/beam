/**
 * The webhook inbox (PL-37 to PL-40). A webhook route is a one-liner over `handleWebhook()`:
 * verify the signature, insert `webhook_events` and enqueue `webhook.process` in one
 * transaction, answer within 2 seconds. The work happens in the job, which calls the
 * provider's handler from `WEBHOOK_HANDLERS` (declared with `defineWebhookHandler`).
 */
import { randomUUID } from "node:crypto";
import type { Db } from "@beam/db";
import { webhookEvents } from "@beam/db/schema";
import { digestRequest } from "@beam/integrations/_shared";
import type { JobKind } from "../registry/types.generated";
import { createCtx, enqueueJob, getAppDb, sql, writeIntegrationCalls, type WebhookProvider } from "./ctx";
import type { JobCtx } from "./job-runner";
import { notifySlack } from "./alerts";
import { reportError } from "./logger";
import { rowsOf } from "./sensitive";

export type { WebhookProvider };

export type WebhookHandlerDefinition = {
  provider: WebhookProvider;
  handle: (ctx: JobCtx, event: { id: string; payload: unknown }) => Promise<void>;
};

export function defineWebhookHandler(def: {
  provider: WebhookProvider;
  handle: (ctx: JobCtx, event: { id: string; payload: unknown }) => Promise<void>;
}): WebhookHandlerDefinition {
  return def;
}

export type VerifyResult = { ok: true; externalEventId: string; payload: unknown } | { ok: false };

/** More than this many signature failures of one provider in 10 minutes raise a Slack alert (PL-37). */
export const SIGNATURE_FAILURE_ALERT = 5;

async function recordSignatureFailure(db: Db, provider: WebhookProvider, req: Request): Promise<void> {
  const path = new URL(req.url).pathname;
  await writeIntegrationCalls(
    db,
    [
      {
        provider,
        operation: "webhook.signature_failed",
        requestDigest: digestRequest({ method: req.method, path }),
        statusCode: 401,
        ok: false,
        durationMs: 0,
        error: "signature_failed",
      },
    ],
    null,
  );
  const rows = rowsOf<{ n: number | string }>(
    await db.execute(sql`
      select count(*)::int as n from integration_calls
      where provider = ${provider} and operation = 'webhook.signature_failed' and created_at > now() - interval '10 minutes'`),
  );
  if (Number(rows[0]?.n ?? 0) > SIGNATURE_FAILURE_ALERT) {
    await db.transaction(async (tx) => {
      const ctx = createCtx({ tx, actor: { kind: "webhook", provider } });
      await notifySlack(ctx, {
        fingerprint: `webhook-signature-${provider}`,
        severity: "high",
        text: `More than ${SIGNATURE_FAILURE_ALERT} ${provider} webhook signature failures in 10 minutes. Check the webhook secret.`,
      });
    });
  }
}

/**
 * Verifies, stores and enqueues. Bad signature: 401, an `integration_calls` row, no event.
 * Duplicate `(provider, external_event_id)`: 200 and nothing enqueued.
 */
export async function handleWebhook(
  req: Request,
  opts: {
    provider: WebhookProvider;
    verify: (raw: string, headers: Headers) => Promise<VerifyResult>;
    db?: Db;
  },
): Promise<Response> {
  const db = opts.db ?? (await getAppDb());
  const raw = await req.text();
  let verified: VerifyResult;
  try {
    verified = await opts.verify(raw, req.headers);
  } catch {
    verified = { ok: false };
  }
  if (!verified.ok) {
    await recordSignatureFailure(db, opts.provider, req).catch((e: unknown) => reportError(e, { tags: { webhook: opts.provider } }));
    return Response.json({ ok: false }, { status: 401 });
  }

  const { externalEventId, payload } = verified;
  await db.transaction(async (tx) => {
    const jobId = randomUUID();
    const inserted = await tx
      .insert(webhookEvents)
      .values({ provider: opts.provider, externalEventId, payload: (payload ?? {}) as Record<string, unknown>, jobId })
      .onConflictDoNothing({ target: [webhookEvents.provider, webhookEvents.externalEventId] })
      .returning({ id: webhookEvents.id });
    const event = inserted[0];
    if (!event) return;
    await enqueueJob(tx, {
      kind: "webhook.process" as JobKind,
      payload: { webhookEventId: event.id },
      key: `webhook:${opts.provider}:${externalEventId}`,
      id: jobId,
    });
  });
  return Response.json({ ok: true }, { status: 200 });
}

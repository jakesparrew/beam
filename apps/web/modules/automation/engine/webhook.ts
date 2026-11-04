/**
 * `automation.call_webhook` (A-33, section 6): posts the signed payload of a `webhook` step.
 * The step itself enqueued this job and advanced at once (fire and forget); this job writes
 * `webhook_called` on 2xx, throws `PermanentError` on 4xx (and 3xx: redirects are never
 * followed) and `RetryableError` on 5xx, 408, 429 and network failures. Dead -> its `onDead`
 * hook writes `failed` (`recordDeadStep`, A-35).
 *
 * Only `WEBHOOK_ALLOWED_FIELDS` of the person leave BEAM. The host is re-checked against
 * `settings.automation_rules.webhook_hosts` at send time, so removing a host stops the calls.
 * Each call is logged to `integration_calls` (provider `webhook`, host only).
 *
 * Decisions: an erased or missing enrolment or person calls nothing (no-op); a missing
 * `AUTOMATION_WEBHOOK_SECRET` is a permanent `webhook_not_configured` failure.
 */
import type { Tx } from "@beam/db";
import { automationEnrolments, automations, automationVersions, persons } from "@beam/db/schema";
import { PermanentError, RetryableError } from "@beam/core/errors";
import { buildWebhookPayload, checkWebhookUrl, webhookIdempotencyKey, type WebhookPayload } from "@beam/core/automation";
import type { IntegrationCallEntry } from "@beam/integrations/_shared";
import { createWebhookClient, type WebhookPoster } from "@beam/integrations/webhook";
import { eq, sql, type Ctx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { getSetting } from "@/lib/settings";
import { versionDefinition } from "./exits";
import { runDedupeKey, writeRun } from "./runs";

export type CallWebhookInput = { enrolmentId: string; stepKey: string };

export type CallWebhookResult =
  | { status: "called"; httpStatus: number; host: string }
  | { status: "noop"; reason: "missing" | "erased" | "already_called" };

export type CallWebhookDeps = { post?: WebhookPoster; secret?: string | undefined };

/** 2xx: done; 5xx, 408 and 429: retry; every other status (3xx, 4xx): permanent. */
export function webhookStatusOutcome(status: number): "ok" | "retry" | "permanent" {
  if (status >= 200 && status < 300) return "ok";
  if (status >= 500 || status === 408 || status === 429) return "retry";
  return "permanent";
}

/** The allow-listed person fields for the payload. */
async function webhookPerson(tx: Tx, personId: string): Promise<Record<string, unknown> | null> {
  const [p] = await tx
    .select({ id: persons.id, firstName: persons.firstName, locale: persons.locale, erasedAt: persons.erasedAt })
    .from(persons)
    .where(eq(persons.id, personId));
  if (!p || p.erasedAt) return null;
  const [status] = rowsOf<{ status: string }>(await tx.execute(sql`select status from v_person_status where person_id = ${personId}::uuid`));
  const tags = rowsOf<{ key: string }>(
    await tx.execute(sql`select t.key from person_tags pt join tags t on t.id = pt.tag_id where pt.person_id = ${personId}::uuid order by t.key`),
  ).map((r) => r.key);
  return { id: p.id, first_name: p.firstName, locale: p.locale, status: status?.status ?? "lead", tags };
}

/** Posts one webhook step (see the file header). */
export async function callWebhook(tx: Tx, ctx: Ctx, input: CallWebhookInput, deps: CallWebhookDeps = {}): Promise<CallWebhookResult> {
  const [e] = await tx
    .select({
      id: automationEnrolments.id,
      personId: automationEnrolments.personId,
      automationId: automationEnrolments.automationId,
      versionId: automationEnrolments.automationVersionId,
      slug: automations.slug,
      definition: automationVersions.definition,
    })
    .from(automationEnrolments)
    .innerJoin(automations, eq(automations.id, automationEnrolments.automationId))
    .innerJoin(automationVersions, eq(automationVersions.id, automationEnrolments.automationVersionId))
    .where(eq(automationEnrolments.id, input.enrolmentId));
  if (!e) return { status: "noop", reason: "missing" };
  const dedupeKey = runDedupeKey(e.id, input.stepKey, "webhook_called");
  if (rowsOf(await tx.execute(sql`select 1 from automation_runs where dedupe_key = ${dedupeKey} limit 1`)).length) {
    return { status: "noop", reason: "already_called" };
  }
  const step = versionDefinition(e.versionId, e.definition)?.steps.find((s) => s.key === input.stepKey);
  if (!step || step.type !== "webhook") throw new PermanentError(`webhook_step_missing:${input.stepKey}`);
  const person = await webhookPerson(tx, e.personId);
  if (!person) return { status: "noop", reason: "erased" };

  const rules = await getSetting(tx, "automation_rules");
  const check = checkWebhookUrl(step.url, rules.webhook_hosts);
  const host = (() => {
    try {
      return new URL(step.url).hostname.toLowerCase();
    } catch {
      return "invalid";
    }
  })();
  if (!check.allowed) throw new PermanentError(`webhook_host_not_allowed:${host}`);
  const secret = "secret" in deps ? deps.secret : process.env.AUTOMATION_WEBHOOK_SECRET;
  if (!secret) throw new PermanentError("webhook_not_configured");

  const payload: WebhookPayload = buildWebhookPayload({ automationSlug: e.slug, stepKey: input.stepKey, enrolmentId: e.id, person, occurredAt: ctx.now });
  const post =
    deps.post ??
    createWebhookClient({
      // `webhook` joins the integration_calls provider enum on platform's side (requested); until then the row is dropped.
      onCall: (entry) => ctx.integrationLog(entry as unknown as IntegrationCallEntry),
    }).postWebhook;
  const { status } = await post({ url: step.url, body: payload, secret, idempotencyKey: webhookIdempotencyKey(e.id, input.stepKey) });
  const outcome = webhookStatusOutcome(status);
  if (outcome === "retry") throw new RetryableError(`webhook_status_${status}`);
  if (outcome === "permanent") throw new PermanentError(`webhook_status_${status}`);
  await writeRun(tx, {
    enrolmentId: e.id,
    personId: e.personId,
    automationId: e.automationId,
    automationVersionId: e.versionId,
    stepKey: input.stepKey,
    outcome: "webhook_called",
    reason: `status ${status}`,
    data: { status, host },
    actor: ctx.actor,
    dedupeKey,
  });
  return { status: "called", httpStatus: status, host };
}

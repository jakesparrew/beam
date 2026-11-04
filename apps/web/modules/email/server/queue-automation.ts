/**
 * Automation sends (email spec rules 39, 39a, 42; cross-module D54), called by automation's
 * `automation.step` after its own checks.
 *
 * - `queueMarketingEmail`: marketing templates (purpose from the template), and code-backed
 *   registry templates that declare `loadProps` sent as a commercial message (D54,
 *   `commerce.checkout_recovery`): purpose `newsletter`, `news.beam.be`, marketing footer,
 *   `List-Unsubscribe` and tracking. Refuses block-backed transactional templates and registry
 *   templates without `loadProps`.
 * - `queueAutomationEmail`: transactional templates only (block-backed, or registry entries;
 *   one without `loadProps` is queued and fails at `email.send` with `invalid_template_data`),
 *   `purpose` null, `mail.beam.be`. Refuses marketing templates.
 *
 * Both write `kind = automation` with `enrolment_id`, the person's locale and email, repeat
 * reachability (marketing only) and the translation check, and return `skipped_unreachable` or
 * `skipped_translation` with a message row in `suppressed` or `blocked_translation` instead of
 * throwing. `context` (or, when absent, `automation_enrolments.context`) and `stepKey` go to
 * `loadProps` (run here, in the caller's transaction; a throwing `loadProps` stores no props, so
 * the send fails with `invalid_template_data`) and to the merge-field resolvers.
 */
import type { DbOrTx } from "@beam/db";
import { emailMessages, persons } from "@beam/db/schema";
import type { AutomationEmailInput, AutomationEmailResult, MarketingPurpose } from "@beam/core/email";
import { isLocale, type Locale } from "@beam/core/i18n";
import { eq, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { rowsOf } from "@/lib/sensitive";
import { getReachability } from "./context";
import { queueMessage, SEND_PRIORITY } from "./send";
import { currentVersionOf, ensureSystemTemplate, registryTemplate, type TemplateRow, type VersionRow } from "./templates-info";

type Mode = "marketing" | "automation";

async function enrolmentContext(tx: DbOrTx, enrolmentId: string): Promise<Record<string, string>> {
  const rows = rowsOf<{ context: Record<string, unknown> | null }>(await tx.execute(sql`select context from automation_enrolments where id = ${enrolmentId}::uuid`));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rows[0]?.context ?? {})) if (typeof v === "string") out[k] = v;
  return out;
}

const statusOf = (s: string | null | undefined): AutomationEmailResult["status"] =>
  s === "suppressed" ? "skipped_unreachable" : s === "blocked_translation" ? "skipped_translation" : "queued";

async function resolveTemplate(ctx: Ctx, slug: string): Promise<{ template: TemplateRow; version: VersionRow } | null> {
  const found = await currentVersionOf(ctx.tx, slug);
  if (found) return found;
  // A registry template whose system row is not seeded yet: create it from the catalogue.
  if (!registryTemplate(slug)) return null;
  await ensureSystemTemplate(ctx.tx, slug);
  return currentVersionOf(ctx.tx, slug);
}

async function queueForAutomation(ctx: Ctx, input: AutomationEmailInput, mode: Mode): Promise<AutomationEmailResult> {
  const tx = ctx.tx;
  const [existing] = await tx
    .select({ id: emailMessages.id, status: emailMessages.status, templateVersionId: emailMessages.templateVersionId })
    .from(emailMessages)
    .where(eq(emailMessages.idempotencyKey, input.idempotencyKey));
  if (existing) return { messageId: existing.id, status: statusOf(existing.status), created: false, templateVersionId: existing.templateVersionId ?? "" };

  const found = await resolveTemplate(ctx, input.templateSlug);
  if (!found) throw new ValidationError("email_template_not_found", { templateSlug: "not_found" });
  const { template, version } = found;
  const def = version.reactComponent ? registryTemplate(version.reactComponent) : null;

  let purpose: MarketingPurpose | null;
  if (mode === "marketing") {
    if (template.kind === "marketing") purpose = template.purpose;
    else if (def?.loadProps) purpose = "newsletter";
    else throw new ValidationError("email_template_not_marketing", { templateSlug: "not_marketing" });
  } else {
    if (template.kind !== "transactional") throw new ValidationError("email_template_not_transactional", { templateSlug: "marketing" });
    purpose = null;
  }

  const [person] = await tx.select({ email: persons.email, locale: persons.locale }).from(persons).where(eq(persons.id, input.personId));
  if (!person) throw new ValidationError("person_not_found", { personId: "not_found" });
  const locale: Locale = isLocale(person.locale) ? person.locale : "nl-BE";
  const context = input.context ?? (await enrolmentContext(tx, input.enrolmentId));

  let status: "queued" | "suppressed" | "blocked_translation" = "queued";
  if (purpose && !(await getReachability(tx, input.personId, purpose)).isReachable) status = "suppressed";
  else if (!version.locales.includes(locale)) status = "blocked_translation";

  let props: unknown = null;
  if (status === "queued" && def?.loadProps) {
    try {
      props = await def.loadProps(tx, { personId: input.personId, locale, context, stepKey: input.stepKey ?? null });
    } catch (error) {
      reportError(error, { tags: { module: "email", template: input.templateSlug } });
      props = null;
    }
  }

  const result = await queueMessage(
    ctx,
    {
      personId: input.personId,
      toEmail: person.email,
      kind: "automation",
      purpose,
      templateVersionId: version.id,
      enrolmentId: input.enrolmentId,
      locale,
      props: props,
      context,
      fromDomain: mode === "marketing" ? "news.beam.be" : "mail.beam.be",
      idempotencyKey: input.idempotencyKey,
      status,
      ...(status === "blocked_translation" ? { error: null } : {}),
    },
    { template: template.slug, priority: SEND_PRIORITY.automation },
  );
  if (result.created && status !== "queued") {
    await ctx.recordEvent({
      kind: "email.blocked",
      personId: input.personId,
      data: { reason: status === "suppressed" ? "suppressed" : "translation" },
      ref: { type: "email_message", id: result.emailMessageId },
      dedupeKey: `email:${result.emailMessageId}:blocked`,
    });
  }
  return { messageId: result.emailMessageId, status: statusOf(result.status), created: result.created, templateVersionId: version.id };
}

export function queueMarketingEmail(ctx: Ctx, input: AutomationEmailInput): Promise<AutomationEmailResult> {
  return queueForAutomation(ctx, input, "marketing");
}

export function queueAutomationEmail(ctx: Ctx, input: AutomationEmailInput): Promise<AutomationEmailResult> {
  return queueForAutomation(ctx, input, "automation");
}

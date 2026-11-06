/**
 * Privacy request state machine and erasure orchestration (ops rules 58-67, 59a, 63a; ops-P5).
 *
 * States (`privacy_requests.status`): `received` → `verified` (staff with a note, or at creation
 * for customer and system requests); `received`/`verified` → `cancelled` (staff, or the customer
 * before `scheduled_for_at`); `verified` → `running` (export at once; erase at `scheduled_for_at`
 * or run-now); `running` → `done` (finalise or the export job) or `failed` (a local step or the
 * export job on its last attempt); `failed` → `running` (run-now, `run_attempt + 1`, every job key
 * new); `verified` → `done` for `restrict` and `object` (applied in the verifying transaction) and
 * `rectify` (`completeRectification`). `done` and `cancelled` are final.
 *
 * Every job key is `privacy:<id>:r<run_attempt>:<step>`. Each module step runs in its own job
 * transaction under `SET LOCAL beam.allow_rewrite = 'on'` and no other session setting
 * (cross-module decision 69).
 */
import type { Tx } from "@beam/db";
import { privacyRequests, processingRestrictions } from "@beam/db/schema";
import { URL_SEGMENT, formatDateTime, isLocale, type Locale } from "@beam/core/i18n";
import {
  brusselsDate,
  ERASE_DELAY_HOURS,
  ERASE_EXTERNAL_PROVIDERS,
  nextEraseModule,
  PRIVACY_DUE_DAYS,
  type ModuleId,
  type PrivacyKind,
  type PrivacyReport,
  type PrivacyWarning,
  type RectifyField,
  type RestrictionReason,
} from "@beam/core/ops";
import { MARKETING_PURPOSES } from "@beam/core/crm";
import { ConflictError, eq, NotFoundError, sql, ValidationError, type Ctx, type DbOrTx } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { addSuppression, getCurrentConsents, recordConsent, restrictProcessing } from "@/modules/crm/api";
import { exitAllForPerson } from "@/modules/automation/api";
import { sendTransactional } from "@/modules/email/api";
import { resyncCustomer } from "@/modules/finance/api";
import { GDPR_REGISTRY } from "@/registry/privacy.generated";
import { addSteps, mergeSteps, PAYMENT_PROVIDERS, reportOf, retainedOf, setExternal, stepsOf, type ReportStep } from "./report";

export type PrivacyRequestRow = typeof privacyRequests.$inferSelect;
export type RequestedBy = "customer" | "staff" | "system";

const HOUR_MS = 3_600_000;
const OPEN = ["received", "verified", "running"] as const;

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export const privacyJobKey = (requestId: string, runAttempt: number, step: string) => `privacy:${requestId}:r${runAttempt}:${step}`;
export const exportKey = (r: Pick<PrivacyRequestRow, "id" | "runAttempt">) => privacyJobKey(r.id, r.runAttempt, "export");
export const startKey = (r: Pick<PrivacyRequestRow, "id" | "runAttempt">, now = false) => privacyJobKey(r.id, r.runAttempt, now ? "start:now" : "start");
export const externalKey = (r: Pick<PrivacyRequestRow, "id" | "runAttempt">, provider: string) => privacyJobKey(r.id, r.runAttempt, `external:${provider}`);
export const stepKey = (r: Pick<PrivacyRequestRow, "id" | "runAttempt">, module: ModuleId) => privacyJobKey(r.id, r.runAttempt, `step:${module}`);
export const finaliseKey = (r: Pick<PrivacyRequestRow, "id" | "runAttempt">) => privacyJobKey(r.id, r.runAttempt, "finalise");

// ---------------------------------------------------------------------------
// Reads and locks
// ---------------------------------------------------------------------------

export async function lockRequest(tx: DbOrTx, requestId: string): Promise<PrivacyRequestRow | null> {
  await tx.execute(sql`select id from privacy_requests where id = ${requestId}::uuid for update`);
  const [row] = await tx.select().from(privacyRequests).where(eq(privacyRequests.id, requestId));
  return row ?? null;
}

async function requireRequest(tx: DbOrTx, requestId: string): Promise<PrivacyRequestRow> {
  const row = await lockRequest(tx, requestId);
  if (!row) throw new NotFoundError("privacy_request_not_found");
  return row;
}

type PersonInfo = { id: string; email: string | null; locale: Locale; erasedAt: Date | null; mergedIntoId: string | null };

export async function lockPerson(tx: DbOrTx, personId: string): Promise<PersonInfo | null> {
  const rows = rowsOf<{ id: string; email: string | null; locale: string; erased_at: Date | string | null; merged_into_id: string | null }>(
    await tx.execute(sql`select id::text as id, email, locale::text as locale, erased_at, merged_into_person_id::text as merged_into_id from persons where id = ${personId}::uuid for update`),
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    email: r.email,
    locale: isLocale(r.locale) ? r.locale : "nl-BE",
    erasedAt: r.erased_at ? new Date(r.erased_at) : null,
    mergedIntoId: r.merged_into_id,
  };
}

/** Another request of the person in `running` (rule 63a). */
export async function otherRunning(tx: DbOrTx, personId: string, requestId: string, kind?: PrivacyKind): Promise<boolean> {
  const kindFilter = kind ? sql` and kind = ${kind}` : sql``;
  const rows = rowsOf<{ n: number }>(
    await tx.execute(sql`select count(*)::int as n from privacy_requests where person_id = ${personId}::uuid and id <> ${requestId}::uuid and status = 'running'${kindFilter}`),
  );
  return Number(rows[0]?.n ?? 0) > 0;
}

/** Rule 61: what an erasure must acknowledge. */
export async function computeWarnings(tx: DbOrTx, personId: string): Promise<PrivacyWarning[]> {
  const rows = rowsOf<Record<PrivacyWarning, boolean>>(
    await tx.execute(sql`select
      exists (select 1 from memberships m where m.person_id = ${personId}::uuid and m.status in ('pending', 'active', 'past_due')) as active_membership,
      exists (select 1 from v_credit_grant_balances b where b.person_id = ${personId}::uuid and b.status = 'active' and b.remaining_units > 0) as credits_remaining,
      exists (select 1 from bookings b join sessions s on s.id = b.session_id where b.person_id = ${personId}::uuid and b.status in ('reserved', 'confirmed') and s.starts_at > now()) as future_bookings,
      exists (select 1 from invoices i where i.person_id = ${personId}::uuid and i.status in ('issued', 'open')) as open_invoices,
      exists (select 1 from orders o where o.person_id = ${personId}::uuid and o.status in ('draft', 'pending_payment')) as open_orders`),
  );
  const r = rows[0];
  if (!r) return [];
  return (["active_membership", "credits_remaining", "future_bookings", "open_invoices", "open_orders"] as const).filter((w) => r[w] === true);
}

function addDaysIso(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const accountPrivacyUrl = (locale: Locale) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}/${URL_SEGMENT[locale]}/account/privacy`;

const staffId = (ctx: Ctx): string | null => (ctx.actor.kind === "staff" ? ctx.actor.userId : null);

// ---------------------------------------------------------------------------
// Create and verify
// ---------------------------------------------------------------------------

export type CreateRequestInput = {
  personId: string;
  kind: PrivacyKind;
  requestedBy: RequestedBy;
  verificationNote?: string;
  rectifyFields?: readonly RectifyField[];
};

/**
 * Rule 59: inserts the request; customer and system requests are verified at once (and applied:
 * export enqueued, erase scheduled, restrict and object done). A second open request of the same
 * kind for the person is a conflict.
 */
export async function createRequest(ctx: Ctx, input: CreateRequestInput): Promise<PrivacyRequestRow> {
  const tx = ctx.tx;
  const person = await lockPerson(tx, input.personId);
  if (!person || person.mergedIntoId) throw new NotFoundError("person_not_found");
  if (person.erasedAt) throw new ConflictError("person_erased");
  const open = rowsOf<{ id: string }>(
    await tx.execute(sql`select id::text as id from privacy_requests where person_id = ${person.id}::uuid and kind = ${input.kind} and status in ('received', 'verified', 'running') limit 1`),
  );
  if (open.length) throw new ConflictError("privacy_request_open");
  if (input.kind === "rectify" && !input.rectifyFields?.length) throw new ValidationError("rectify_fields_required", { rectifyFields: "required" });
  const warnings = input.kind === "erase" ? await computeWarnings(tx, person.id) : [];
  const [row] = await tx
    .insert(privacyRequests)
    .values({
      personId: person.id,
      kind: input.kind,
      requestedBy: input.requestedBy,
      dueOn: addDaysIso(brusselsDate(ctx.now), PRIVACY_DUE_DAYS),
      verificationNote: input.verificationNote?.trim() || null,
      rectifyFields: input.kind === "rectify" ? [...new Set(input.rectifyFields ?? [])] : [],
      warnings,
      createdByUserId: staffId(ctx),
    })
    .returning();
  await ctx.recordEvent({ kind: "privacy.requested", personId: person.id, data: { kind: input.kind }, dedupeKey: `privacy:${row!.id}:requested` });
  await ctx.audit({ action: "privacy.requested", entityType: "privacy_request", entityId: row!.id, personId: person.id, newValue: { kind: input.kind, requestedBy: input.requestedBy, rectifyFields: row!.rectifyFields } });
  if (input.requestedBy === "staff") return row!;
  return verifyAndApply(ctx, row!, person, { note: row!.verificationNote, byUserId: null });
}

/** Staff verification (rule 59): needs a note; an erasure with warnings needs them acknowledged. */
export async function verifyRequest(ctx: Ctx, input: { requestId: string; verificationNote: string; acknowledgeWarnings: boolean }): Promise<PrivacyRequestRow> {
  const row = await requireRequest(ctx.tx, input.requestId);
  if (row.status !== "received") throw new ConflictError(`privacy_request_${row.status}`);
  const person = await lockPerson(ctx.tx, row.personId);
  if (!person || person.erasedAt) throw new ConflictError("person_erased");
  let current = row;
  if (row.kind === "erase") {
    const warnings = await computeWarnings(ctx.tx, row.personId);
    if (warnings.length && !input.acknowledgeWarnings) throw new ValidationError("warnings_not_acknowledged", { acknowledgeWarnings: "required" });
    [current] = (await ctx.tx.update(privacyRequests).set({ warnings, updatedAt: ctx.now }).where(eq(privacyRequests.id, row.id)).returning()) as [PrivacyRequestRow];
  }
  return verifyAndApply(ctx, current, person, { note: input.verificationNote.trim(), byUserId: staffId(ctx) });
}

async function verifyAndApply(ctx: Ctx, row: PrivacyRequestRow, person: PersonInfo, by: { note: string | null; byUserId: string | null }): Promise<PrivacyRequestRow> {
  const tx = ctx.tx;
  const patch: Partial<typeof privacyRequests.$inferInsert> = { status: "verified", verifiedAt: ctx.now, verifiedByUserId: by.byUserId, verificationNote: by.note, updatedAt: ctx.now };
  if (row.kind === "erase") patch.scheduledForAt = new Date(ctx.now.getTime() + ERASE_DELAY_HOURS * HOUR_MS);
  if (row.kind === "export") patch.status = "running";
  if (row.kind === "restrict" || row.kind === "object") Object.assign(patch, { status: "done", completedAt: ctx.now });
  const [updated] = await tx.update(privacyRequests).set(patch).where(eq(privacyRequests.id, row.id)).returning();
  const next = updated!;
  await ctx.recordEvent({ kind: "privacy.verified", personId: row.personId, data: { kind: row.kind }, dedupeKey: `privacy:${row.id}:verified` });
  await ctx.audit({ action: "privacy.verified", entityType: "privacy_request", entityId: row.id, personId: row.personId, newValue: { kind: row.kind, verifiedByUserId: by.byUserId } });

  switch (row.kind) {
    case "export":
      await ctx.enqueue({ kind: "privacy.export", payload: { requestId: row.id }, key: exportKey(next) });
      break;
    case "erase":
      await ctx.enqueue({ kind: "privacy.erase", payload: { requestId: row.id }, key: startKey(next), runAt: next.scheduledForAt! });
      // Rule 64: the confirmation goes out now, because no address exists afterwards; system requests send none.
      if (row.requestedBy !== "system" && person.email) {
        await sendTransactional(ctx, {
          template: "ops.privacy_erasure_scheduled",
          personId: row.personId,
          locale: person.locale,
          data: { requestId: row.id, date: formatDateTime(next.scheduledForAt!, person.locale, "long"), accountUrl: accountPrivacyUrl(person.locale) },
          key: `privacy:${row.id}:email:erasure_scheduled`,
        });
      }
      break;
    case "restrict":
      await applyRestriction(ctx, row.personId, { requestId: row.id, reason: "accuracy_contested" });
      break;
    case "object":
      await applyObjection(ctx, row.personId, person.email);
      break;
    case "rectify":
      break;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Restriction, objection, rectification (rules 65-67)
// ---------------------------------------------------------------------------

/** Withdraws every granted marketing purpose (method `staff`), never re-grants. */
async function withdrawMarketing(ctx: Ctx, personId: string, source: string): Promise<number> {
  const current = await getCurrentConsents(ctx.tx, personId);
  let n = 0;
  for (const purpose of MARKETING_PURPOSES) {
    if (current[purpose]?.status !== "granted") continue;
    // crm accepts the fixed wording `restriction` for a withdrawal by a privacy request.
    await recordConsent(ctx.tx, ctx, { personId, purpose, status: "withdrawn", method: "staff", source, wordingVersion: "restriction" });
    n += 1;
  }
  return n;
}

/** Rule 65: row, flag, consents withdrawn, marketing enrolments exited, `privacy.restricted`. */
export async function applyRestriction(ctx: Ctx, personId: string, input: { requestId: string | null; reason: RestrictionReason }): Promise<void> {
  const tx = ctx.tx;
  await tx
    .insert(processingRestrictions)
    .values({ personId, privacyRequestId: input.requestId, reason: input.reason, startedByUserId: staffId(ctx) })
    .onConflictDoNothing({ target: processingRestrictions.personId });
  await restrictProcessing(tx, ctx, personId, true);
  await withdrawMarketing(ctx, personId, "privacy_restriction");
  await exitAllForPerson(tx, ctx, personId, "restricted");
  await ctx.recordEvent({ kind: "privacy.restricted", personId, data: {}, dedupeKey: input.requestId ? `privacy:${input.requestId}:restricted` : undefined });
}

/** Rule 66: consents withdrawn, enrolments exited, suppression `all`/`manual`; no flag, no row. */
export async function applyObjection(ctx: Ctx, personId: string, email: string | null): Promise<void> {
  await withdrawMarketing(ctx, personId, "privacy_objection");
  await exitAllForPerson(ctx.tx, ctx, personId, "objected");
  if (email) await addSuppression(ctx.tx, ctx, { email, scope: "all", reason: "manual", source: "privacy_objection", personId });
  await ctx.recordEvent({ kind: "privacy.objected", personId, data: {} });
}

/** Lifting deletes the row and clears the flag; consent is never re-granted (rule 65). */
export async function liftRestriction(ctx: Ctx, input: { personId: string; reason: string }): Promise<void> {
  const tx = ctx.tx;
  const deleted = await tx.delete(processingRestrictions).where(eq(processingRestrictions.personId, input.personId)).returning({ id: processingRestrictions.id, reason: processingRestrictions.reason });
  if (!deleted.length) throw new NotFoundError("restriction_not_found");
  await restrictProcessing(tx, ctx, input.personId, false);
  await ctx.recordEvent({ kind: "privacy.restriction_lifted", personId: input.personId, data: {} });
  await ctx.audit({
    action: "privacy.restriction_lifted",
    entityType: "processing_restriction",
    entityId: deleted[0]!.id,
    personId: input.personId,
    oldValue: { reason: deleted[0]!.reason },
    newValue: { lifted: true, note: input.reason },
  });
}

/** Rule 67: staff corrected the fields on the person page; finance resyncs its Billit party. */
export async function completeRectification(ctx: Ctx, requestId: string): Promise<void> {
  const row = await requireRequest(ctx.tx, requestId);
  if (row.kind !== "rectify") throw new ValidationError("not_a_rectification", { requestId: "kind" });
  if (row.status !== "verified") throw new ConflictError(`privacy_request_${row.status}`);
  await ctx.tx.update(privacyRequests).set({ status: "done", completedAt: ctx.now, updatedAt: ctx.now }).where(eq(privacyRequests.id, row.id));
  await resyncCustomer(ctx.tx, ctx, row.personId);
  await ctx.audit({ action: "privacy.rectified", entityType: "privacy_request", entityId: row.id, personId: row.personId, newValue: { fields: row.rectifyFields } });
}

// ---------------------------------------------------------------------------
// Cancel and run now
// ---------------------------------------------------------------------------

/** Staff cancel (`received` or `verified` only). */
export async function cancelRequest(ctx: Ctx, input: { requestId: string; reason: string }): Promise<void> {
  const row = await requireRequest(ctx.tx, input.requestId);
  if (row.status !== "received" && row.status !== "verified") throw new ConflictError(`privacy_request_${row.status}`);
  await markCancelled(ctx, row, input.reason);
}

/** The customer's cancel of their own erasure, before `scheduled_for_at`. */
export async function cancelOwnErasure(ctx: Ctx, input: { requestId: string; personId: string }): Promise<void> {
  const row = await lockRequest(ctx.tx, input.requestId);
  if (!row || row.personId !== input.personId) throw new NotFoundError("privacy_request_not_found");
  if (row.kind !== "erase" || (row.status !== "received" && row.status !== "verified")) throw new ConflictError(`privacy_request_${row.status}`);
  if (row.scheduledForAt && row.scheduledForAt.getTime() <= ctx.now.getTime()) throw new ConflictError("erasure_started");
  await markCancelled(ctx, row, null);
}

async function markCancelled(ctx: Ctx, row: PrivacyRequestRow, reason: string | null): Promise<void> {
  await ctx.tx.update(privacyRequests).set({ status: "cancelled", completedAt: ctx.now, updatedAt: ctx.now }).where(eq(privacyRequests.id, row.id));
  await ctx.recordEvent({ kind: "privacy.cancelled", personId: row.personId, data: { kind: row.kind }, dedupeKey: `privacy:${row.id}:cancelled` });
  await ctx.audit({ action: "privacy.cancelled", entityType: "privacy_request", entityId: row.id, personId: row.personId, oldValue: { status: row.status }, newValue: { status: "cancelled", reason } });
}

/**
 * `privacy.run` staff start a verified erasure at once, or rerun a failed export or erasure
 * (`run_attempt + 1`, so every job key is new; the erasure reruns from the external steps).
 */
export async function runNow(ctx: Ctx, requestId: string): Promise<{ jobId: string }> {
  const row = await requireRequest(ctx.tx, requestId);
  if (row.kind === "erase") ctx.require("persons.erase");
  if (row.kind !== "erase" && row.kind !== "export") throw new ValidationError("not_runnable", { requestId: "kind" });
  let next: PrivacyRequestRow;
  if (row.status === "failed") {
    [next] = (await ctx.tx
      .update(privacyRequests)
      .set({ status: "running", runAttempt: row.runAttempt + 1, completedAt: null, updatedAt: ctx.now })
      .where(eq(privacyRequests.id, row.id))
      .returning()) as [PrivacyRequestRow];
  } else if (row.status === "verified" && row.kind === "erase") {
    [next] = (await ctx.tx.update(privacyRequests).set({ scheduledForAt: ctx.now, updatedAt: ctx.now }).where(eq(privacyRequests.id, row.id)).returning()) as [PrivacyRequestRow];
  } else {
    throw new ConflictError(`privacy_request_${row.status}`);
  }
  const job =
    row.kind === "erase"
      ? await ctx.enqueue({ kind: "privacy.erase", payload: { requestId: row.id }, key: startKey(next, true) })
      : await ctx.enqueue({ kind: "privacy.export", payload: { requestId: row.id }, key: exportKey(next) });
  await ctx.audit({ action: "privacy.started", entityType: "privacy_request", entityId: row.id, newValue: { kind: row.kind, runAttempt: next.runAttempt, from: row.status } });
  return { jobId: job.id };
}

// ---------------------------------------------------------------------------
// Erasure pipeline (rules 61-64)
// ---------------------------------------------------------------------------

async function writeReport(tx: Tx, requestId: string, report: PrivacyReport, extra: Partial<typeof privacyRequests.$inferInsert> = {}): Promise<void> {
  await tx.update(privacyRequests).set({ report, updatedAt: new Date(), ...extra }).where(eq(privacyRequests.id, requestId));
}

/** Payment providers the person has payments with, recorded as `provider_retains`, plus Anthropic (rule 63). */
async function retainingProviders(tx: DbOrTx, personId: string): Promise<("mollie" | "stripe" | "viva")[]> {
  const rows = rowsOf<{ provider: string }>(
    await tx.execute(sql`select distinct p.provider::text as provider from payments p join orders o on o.id = p.order_id
      where o.person_id = ${personId}::uuid and p.provider::text in ('mollie', 'stripe', 'viva') order by 1`),
  );
  return rows.map((r) => r.provider).filter((p): p is (typeof PAYMENT_PROVIDERS)[number] => (PAYMENT_PROVIDERS as readonly string[]).includes(p));
}

export type StartOutcome = { started: boolean; reason?: string };

/**
 * `privacy.erase`: proceeds only for a `verified` request whose `scheduled_for_at` has passed, or
 * a `running` one (run-now after `failed`); the later of two start jobs re-enqueues the same
 * keys, which the job table dedupes. Throws `busy` (the caller turns it into a retry) while
 * another request of the person runs (rule 63a).
 */
export async function startErasure(ctx: Ctx, requestId: string): Promise<StartOutcome | "busy"> {
  const tx = ctx.tx;
  const row = await lockRequest(tx, requestId);
  if (!row || row.kind !== "erase") return { started: false, reason: "missing" };
  if (row.status === "verified") {
    if (!row.scheduledForAt || row.scheduledForAt.getTime() > ctx.now.getTime()) return { started: false, reason: "not_due" };
  } else if (row.status !== "running") {
    return { started: false, reason: row.status };
  }
  await lockPerson(tx, row.personId);
  if (await otherRunning(tx, row.personId, row.id)) return "busy";
  const previous = reportOf(row.report);
  const providers = await retainingProviders(tx, row.personId);
  let external = previous.external.filter((e) => e.outcome === "provider_retains");
  for (const p of providers) external = setExternal(external, p, "provider_retains");
  external = setExternal(external, "anthropic", "provider_retains");
  const report: PrivacyReport = { ...previous, external, startedAt: previous.startedAt ?? ctx.now.toISOString() };
  delete report.finishedAt;
  await writeReport(tx, row.id, report, { status: "running", needsManualFollowup: false });
  const running = { id: row.id, runAttempt: row.runAttempt };
  for (const provider of ERASE_EXTERNAL_PROVIDERS) {
    await ctx.enqueue({ kind: "privacy.erase_external", payload: { requestId: row.id, provider }, key: externalKey(running, provider) });
  }
  return { started: true };
}

/** All three external providers recorded for this attempt (they are reset at each start). */
export function allExternalRecorded(report: PrivacyReport): boolean {
  return ERASE_EXTERNAL_PROVIDERS.every((p) => report.external.some((e) => e.provider === p && e.outcome !== "provider_retains"));
}

/**
 * Runs one module's registry `erase` in the caller's transaction under
 * `SET LOCAL beam.allow_rewrite = 'on'` (the only session setting) and merges its rows into the
 * report (the latest count per table wins, so a rerun stays correct). Returns the module's steps.
 */
export async function runEraseStep(tx: Tx, requestId: string, module: ModuleId): Promise<PrivacyReport["steps"]> {
  const row = await lockRequest(tx, requestId);
  if (!row) throw new NotFoundError("privacy_request_not_found");
  await tx.execute(sql`set local beam.allow_rewrite = 'on'`);
  const registry = GDPR_REGISTRY as Readonly<Record<string, { erase(tx: Tx, personId: string): Promise<{ table: string; rows: number; action: string }[]> } | undefined>>;
  const report = reportOf(row.report);
  if (module === "crm") {
    // The steps run one transaction each, so automation can still enrol the person between its
    // own step and this one (an event of just before the request, dispatched late). Such an
    // enrolment references one of the person's activity_events (restrict), and crm could never
    // delete them: the erasure stayed `running`. Lock the person (automation's enrol takes
    // `for no key update` on it, so it waits and then sees `erased_at`), sweep automation again,
    // and count what the sweep caught on top of automation's step.
    await tx.execute(sql`select id from persons where id = ${row.personId}::uuid or merged_into_person_id = ${row.personId}::uuid for update`);
    const late = registry.automation ? await registry.automation.erase(tx, row.personId) : [];
    report.steps = addSteps(report.steps, stepsOf("automation", late));
  }
  const registration = registry[module];
  const rows = registration ? await registration.erase(tx, row.personId) : [];
  const steps: ReportStep[] = stepsOf(module, rows);
  report.steps = mergeSteps(report.steps, module, steps);
  report.retained = retainedOf(report.steps);
  await writeReport(tx, row.id, report);
  return steps;
}

/** The job after `module`: the next module step, or finalise after `platform`. */
export async function enqueueAfterStep(ctx: Ctx, row: Pick<PrivacyRequestRow, "id" | "runAttempt">, module: ModuleId): Promise<void> {
  const next = nextEraseModule(module);
  if (next) await ctx.enqueue({ kind: "privacy.erase_step", payload: { requestId: row.id, module: next }, key: stepKey(row, next) });
  else await ctx.enqueue({ kind: "privacy.finalise", payload: { requestId: row.id }, key: finaliseKey(row) });
}

export const isOpenStatus = (s: PrivacyRequestRow["status"]) => (OPEN as readonly string[]).includes(s);

"use server";
/**
 * credits Server Actions (credits spec section 4 "Server actions", all through `action()`).
 * credits-P6: the staff actions of the back-office on grants (`credits.adjust`), bulk extensions,
 * reconciliation and membership plans and memberships (`memberships.write`). Every handler writes
 * its own audit row with the spec's audit name (section 7), so the wrapper's automatic row is off
 * (`audit: false`): one audit row per staff action. Ledger writes go through `server/ledger.ts`,
 * membership writes through `server/memberships.ts` (row lock, `version` check). Old and new
 * values carry balances, dates and statuses, never notes or other personal data. The customer
 * actions (`cancelMyMembership`, `resumeMyMembership`, `payMyRenewal`) come with credits-P7.
 */
import { z } from "zod";
import { creditGrants, membershipPlanBenefits, membershipPlanInclusions, memberships, persons, products } from "@beam/db/schema";
import {
  AdjustGrantInput,
  BulkExtendInput,
  CancelMembershipInput,
  computeExpiresAt,
  CreateGrantInput,
  endOfDayIn,
  ExtendGrantInput,
  ExtendMembershipPeriodInput,
  NO_SHARING,
  PlanBenefitInput,
  PlanInclusionInput,
  RemovePlanBenefitInput,
  ResumeMembershipInput,
  RevokeGrantInput,
  TransferCreditsInput,
  UpdateGrantNoteInput,
  UpdateMembershipNotesInput,
  brusselsDateKey,
  type GrantSharing,
} from "@beam/core/credits";
import { action } from "@/lib/action";
import { and, ConflictError, eq, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { getActiveMandate } from "@/modules/commerce/api";
import { searchPersons } from "@/modules/crm/api";
import { translator } from "@/lib/i18n";
import { previewBulkExtension, startBulkExtension } from "./server/bulk-extend";
import * as ledger from "./server/ledger";
import { lockMembership, renewalJobKey } from "./server/memberships";
import * as membershipService from "./server/memberships";

/** At most 12 active benefits per plan (spec section 2, `membership_plan_benefits`). */
const MAX_ACTIVE_BENEFITS = 12;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` date is the end of that Brussels day; any other value is an instant. */
const expiryDate = z.union([z.string().regex(DATE_ONLY), z.coerce.date()]).transform((v) => {
  if (typeof v !== "string") return v;
  const [year, month, day] = v.split("-").map(Number) as [number, number, number];
  return endOfDayIn({ year, month, day });
});

/** The form sends the expiry as a date: the end of that Brussels day (rule 1's end-of-day convention). */
const CreateGrantAction = z.preprocess((raw) => {
  const v = raw as { expiresAt?: unknown } | null;
  if (!v || typeof v !== "object" || typeof v.expiresAt !== "string") return raw;
  if (v.expiresAt === "") return { ...v, expiresAt: undefined };
  return DATE_ONLY.test(v.expiresAt) ? { ...v, expiresAt: expiryDate.parse(v.expiresAt) } : raw;
}, CreateGrantInput);

const notFoundUnlessUuid = (id: string, what: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundError(`${what}_not_found`);
};

async function assertPerson(ctx: Ctx, personId: string): Promise<void> {
  const [p] = await ctx.tx.select({ id: persons.id, erasedAt: persons.erasedAt, mergedInto: persons.mergedIntoPersonId }).from(persons).where(eq(persons.id, personId));
  if (!p) throw new NotFoundError("person_not_found");
  if (p.erasedAt) throw new ConflictError("person_erased");
  if (p.mergedInto) throw new ConflictError("person_merged");
}

async function assertGrant(ctx: Ctx, grantId: string): Promise<void> {
  notFoundUnlessUuid(grantId, "grant");
  const [g] = await ctx.tx.select({ id: creditGrants.id }).from(creditGrants).where(eq(creditGrants.id, grantId));
  if (!g) throw new NotFoundError("grant_not_found");
}

function sharingFor(mode: "none" | "guests" | "named" | undefined, kind: "day" | "night" | "euro"): GrantSharing | undefined {
  if (!mode || mode === "none" || kind === "euro") return { ...NO_SHARING, allowed_person_ids: [] };
  return { mode, max_guest_uses_per_month: mode === "guests" ? 2 : 0, allowed_person_ids: [] };
}

// ---------------------------------------------------------------------------
// Grants (credits.adjust)
// ---------------------------------------------------------------------------

/** Rule 4: a manual or bonus grant with its first `grant` entry, key `grant:staff:<client_key>`. */
export const createGrant = action(
  { name: "credits.create_grant", audience: "staff", permission: "credits.adjust", input: CreateGrantAction, audit: false },
  async (ctx, input) => {
    await assertPerson(ctx, input.personId);
    const expiresAt = input.noExpiry ? null : input.expiresAt !== undefined ? input.expiresAt : computeExpiresAt(ctx.now, input.validityDays ?? null);
    if (expiresAt && expiresAt.getTime() <= ctx.now.getTime()) throw new ValidationError("validation", { expiresAt: "must be in the future" });
    const r = await ledger.grantCredits(ctx.tx, ctx, {
      personId: input.personId,
      kind: input.kind,
      units: input.units,
      source: input.source,
      label: input.label,
      expiresAt,
      reason: input.reason,
      sharing: sharingFor(input.sharingMode, input.kind),
      key: `grant:staff:${input.clientKey}`,
    });
    if (r.created) {
      await ctx.audit({
        action: "credits.grant_created",
        entityType: "credit_grant",
        entityId: r.grantId,
        personId: input.personId,
        oldValue: null,
        newValue: { kind: input.kind, units: input.units, source: input.source, balance: input.units, expires_at: expiresAt?.toISOString() ?? null },
      });
    }
    return r;
  },
);

/** Rule 33: a non-zero `adjust` with a reason (audit with old and new balance). */
export const adjustGrant = action(
  { name: "credits.adjust_grant", audience: "staff", permission: "credits.adjust", input: AdjustGrantInput, audit: false },
  async (ctx, input) => {
    await assertGrant(ctx, input.grantId);
    return ledger.adjust(ctx.tx, ctx, input);
  },
);

/** Rules 31 and 32: a later expiry (a date is the end of that Brussels day); reinstates a recently expired grant. */
export const extendGrant = action(
  {
    name: "credits.extend_grant",
    audience: "staff",
    permission: "credits.adjust",
    input: ExtendGrantInput.extend({ newExpiresAt: expiryDate }),
    audit: false,
  },
  async (ctx, input) => {
    await assertGrant(ctx, input.grantId);
    return ledger.extend(ctx.tx, ctx, { grantId: input.grantId, newExpiresAt: input.newExpiresAt, reason: input.reason, clientKey: input.clientKey });
  },
);

/** Rule 28: revokes every remaining unit; the grant becomes `revoked`. */
export const revokeGrant = action(
  { name: "credits.revoke_grant", audience: "staff", permission: "credits.adjust", input: RevokeGrantInput, audit: false },
  async (ctx, input) => {
    await assertGrant(ctx, input.grantId);
    return ledger.revoke(ctx.tx, ctx, input);
  },
);

/** Rule 34: `transfer_out` on the source and a new `transfer` grant of the recipient, one audit row. */
export const transferCredits = action(
  { name: "credits.transfer", audience: "staff", permission: "credits.adjust", input: TransferCreditsInput, audit: false },
  async (ctx, input) => {
    await assertGrant(ctx, input.grantId);
    await assertPerson(ctx, input.toPersonId);
    return ledger.transfer(ctx.tx, ctx, input);
  },
);

/** The staff note of a grant (PII-risk: the audit row records only whether a note is set). */
export const updateGrantNote = action(
  { name: "credits.update_note", audience: "staff", permission: "credits.adjust", input: UpdateGrantNoteInput, audit: false },
  async (ctx, input) => {
    notFoundUnlessUuid(input.grantId, "grant");
    const [grant] = await ledger.lockGrants(ctx.tx, [input.grantId]);
    if (!grant) throw new NotFoundError("grant_not_found");
    const note = input.note.trim() || null;
    if ((grant.note ?? null) === note) return { changed: false };
    await ctx.tx.update(creditGrants).set({ note, updatedAt: ctx.now }).where(eq(creditGrants.id, grant.id));
    await ctx.audit({
      action: "credits.note_changed",
      entityType: "credit_grant",
      entityId: grant.id,
      personId: grant.personId,
      oldValue: { has_note: !!grant.note, length: grant.note?.length ?? 0 },
      newValue: { has_note: !!note, length: note?.length ?? 0 },
    });
    return { changed: true };
  },
);

/** A manual `ledger.reconcile` run (key `ledger_reconcile:manual:<request_id>`, DM-5). */
export const requestReconcile = action(
  { name: "credits.request_reconcile", audience: "staff", permission: "credits.adjust", input: z.object({}), audit: false },
  async (ctx) => {
    const job = await ctx.enqueue({ kind: "ledger.reconcile", payload: { manual: true }, key: `ledger_reconcile:manual:${ctx.requestId}` });
    await ctx.audit({
      action: "credits.reconcile_requested",
      entityType: "credit_reconciliation_run",
      entityId: null,
      oldValue: null,
      newValue: { request_id: ctx.requestId },
    });
    return { jobId: job.id };
  },
);

/** Rule 32a: one `credit_bulk_extensions` row (id = `clientKey`) and one `credits.bulk_extend` job. */
export const bulkExtendGrants = action(
  { name: "credits.bulk_extend", audience: "staff", permission: "credits.adjust", input: BulkExtendInput, audit: false },
  (ctx, input) => startBulkExtension(ctx.tx, ctx, input),
);

/** The live preview of the bulk-extension form: the matched count and its sentence in the staff locale (read only). */
export const previewBulkExtend = action(
  {
    name: "credits.preview_bulk_extend",
    audience: "staff",
    permission: "credits.adjust",
    input: z.object({
      days: z.number().int().min(1).max(90),
      kinds: z.array(z.enum(["day", "night", "euro"])).min(1),
      sources: z.array(z.enum(["purchase", "voucher", "bonus", "import", "manual", "referral", "transfer"])).min(1),
      expiresFromOn: z.string().regex(DATE_ONLY),
      expiresToOn: z.string().regex(DATE_ONLY),
    }),
    audit: false,
  },
  async (ctx, input) => {
    const { matched } = await previewBulkExtension(ctx.tx, input);
    return { matched, text: translator(ctx.locale)("credits.admin.bulk_extend.preview", { count: matched, days: input.days }) };
  },
);

/** The person picker of the new-grant and transfer forms (up to 8 matches). */
export const findCreditPersons = action(
  { name: "credits.find_persons", audience: "staff", permission: "credits.adjust", input: z.object({ q: z.string().trim().min(2).max(100) }), audit: false },
  async (ctx, input) => (await searchPersons(ctx.tx, { q: input.q, limit: 8 })).map((p) => ({ id: p.personId, name: p.name, email: p.email, customerNumber: p.customerNumber })),
);

// ---------------------------------------------------------------------------
// Membership plans (memberships.write)
// ---------------------------------------------------------------------------

async function membershipPlan(ctx: Ctx, productId: string) {
  notFoundUnlessUuid(productId, "plan");
  const [p] = await ctx.tx
    .select({ id: products.id, kind: products.kind, includedCreditKind: products.includedCreditKind })
    .from(products)
    .where(eq(products.id, productId))
    .for("update");
  if (!p || p.kind !== "membership") throw new NotFoundError("plan_not_found");
  return p;
}

/** An extra included kind per period (`membership_plan_inclusions`); never the product's primary kind. */
export const setPlanInclusion = action(
  { name: "memberships.set_inclusion", audience: "staff", permission: "memberships.write", input: PlanInclusionInput, audit: false },
  async (ctx, input) => {
    const plan = await membershipPlan(ctx, input.productId);
    if (plan.includedCreditKind === input.kind) throw new ValidationError("validation", { kind: "primary_inclusion" });
    const [old] = await ctx.tx
      .select()
      .from(membershipPlanInclusions)
      .where(and(eq(membershipPlanInclusions.productId, plan.id), eq(membershipPlanInclusions.creditKind, input.kind)));
    const [row] = old
      ? await ctx.tx
          .update(membershipPlanInclusions)
          .set({ unitsPerPeriod: input.unitsPerPeriod, isActive: input.isActive, updatedAt: ctx.now })
          .where(eq(membershipPlanInclusions.id, old.id))
          .returning()
      : await ctx.tx
          .insert(membershipPlanInclusions)
          .values({ productId: plan.id, creditKind: input.kind, unitsPerPeriod: input.unitsPerPeriod, isActive: input.isActive })
          .returning();
    await ctx.audit({
      action: "memberships.inclusion_changed",
      entityType: "product",
      entityId: plan.id,
      oldValue: old ? { kind: old.creditKind, units_per_period: old.unitsPerPeriod, is_active: old.isActive } : null,
      newValue: { kind: input.kind, units_per_period: input.unitsPerPeriod, is_active: input.isActive },
    });
    return { inclusionId: row!.id };
  },
);

/** A benefit line of a plan (text complete in the three locales; at most 12 active per plan). */
export const setPlanBenefit = action(
  { name: "memberships.set_benefit", audience: "staff", permission: "memberships.write", input: PlanBenefitInput, audit: false },
  async (ctx, input) => {
    const plan = await membershipPlan(ctx, input.productId);
    let old: typeof membershipPlanBenefits.$inferSelect | undefined;
    if (input.benefitId) {
      [old] = await ctx.tx.select().from(membershipPlanBenefits).where(eq(membershipPlanBenefits.id, input.benefitId));
      if (!old || old.productId !== plan.id) throw new NotFoundError("benefit_not_found");
    }
    if (input.isActive && !old?.isActive) {
      const [n] = await ctx.tx
        .select({ n: sql<number>`count(*)::int` })
        .from(membershipPlanBenefits)
        .where(and(eq(membershipPlanBenefits.productId, plan.id), eq(membershipPlanBenefits.isActive, true)));
      if (Number(n?.n ?? 0) >= MAX_ACTIVE_BENEFITS) throw new ConflictError("too_many_benefits");
    }
    const values = { kind: input.kind, text: input.text, sortOrder: input.sortOrder, isActive: input.isActive };
    const [row] = old
      ? await ctx.tx.update(membershipPlanBenefits).set({ ...values, updatedAt: ctx.now }).where(eq(membershipPlanBenefits.id, old.id)).returning()
      : await ctx.tx.insert(membershipPlanBenefits).values({ productId: plan.id, ...values }).returning();
    await ctx.audit({
      action: "memberships.benefit_changed",
      entityType: "membership_plan_benefit",
      entityId: row!.id,
      oldValue: old ? { kind: old.kind, text: old.text, sort_order: old.sortOrder, is_active: old.isActive } : null,
      newValue: { product_id: plan.id, kind: input.kind, text: input.text, sort_order: input.sortOrder, is_active: input.isActive },
    });
    return { benefitId: row!.id };
  },
);

/** Removes a benefit line (display only; nothing else references it). */
export const removePlanBenefit = action(
  { name: "memberships.remove_benefit", audience: "staff", permission: "memberships.write", input: RemovePlanBenefitInput, audit: false },
  async (ctx, input) => {
    const [old] = await ctx.tx.select().from(membershipPlanBenefits).where(eq(membershipPlanBenefits.id, input.benefitId));
    if (!old) throw new NotFoundError("benefit_not_found");
    await ctx.tx.delete(membershipPlanBenefits).where(eq(membershipPlanBenefits.id, old.id));
    await ctx.audit({
      action: "memberships.benefit_changed",
      entityType: "membership_plan_benefit",
      entityId: old.id,
      oldValue: { product_id: old.productId, kind: old.kind, text: old.text, sort_order: old.sortOrder, is_active: old.isActive },
      newValue: null,
    });
    return { removed: true };
  },
);

// ---------------------------------------------------------------------------
// Memberships (memberships.write)
// ---------------------------------------------------------------------------

async function membershipVersion(ctx: Ctx, membershipId: string, version: number) {
  notFoundUnlessUuid(membershipId, "membership");
  const m = await lockMembership(ctx.tx, membershipId);
  if (m.version !== version) throw new ConflictError("stale_version");
  return m;
}

/** Rules 53 and 54: at period end (`active` only) or now (`pending`, `past_due` and `active`), with a reason. */
export const cancelMembership = action(
  { name: "memberships.cancel", audience: "staff", permission: "memberships.write", input: CancelMembershipInput, audit: false },
  async (ctx, input) => {
    const m = await membershipVersion(ctx, input.membershipId, input.version);
    if (input.mode === "period_end" && m.status !== "active") throw new ConflictError(m.status === "pending" || m.status === "past_due" ? "cancel_now_only" : `membership_${m.status}`);
    if (input.mode === "now") {
      const row = await membershipService.cancelNow(ctx.tx, ctx, { membershipId: m.id, by: "staff", reason: input.reason, version: input.version });
      return { mode: "now" as const, status: row.status, version: row.version };
    }
    const r = await membershipService.requestCancel(ctx.tx, ctx, { membershipId: m.id, by: "staff", reason: input.reason, version: input.version });
    return { mode: r.mode, status: r.membership.status, version: r.membership.version };
  },
);

/** Rule 53: resume before `cancel_at`. */
export const resumeMembership = action(
  { name: "memberships.resume", audience: "staff", permission: "memberships.write", input: ResumeMembershipInput, audit: false },
  async (ctx, input) => {
    await membershipVersion(ctx, input.membershipId, input.version);
    const row = await membershipService.resume(ctx.tx, ctx, input);
    return { status: row.status, version: row.version };
  },
);

/** Rule 55: the V1 pause (1 to 90 days, optionally also this period's included units). */
export const extendMembershipPeriod = action(
  { name: "memberships.extend_period", audience: "staff", permission: "memberships.write", input: ExtendMembershipPeriodInput, audit: false },
  async (ctx, input) => {
    notFoundUnlessUuid(input.membershipId, "membership");
    return membershipService.extendPeriod(ctx.tx, ctx, input);
  },
);

/**
 * A staff retry of a `past_due` renewal with a valid mandate: makes the next attempt due now and
 * enqueues `memberships.charge_renewal` (key `renewal:<id>:<period_end>:manual:<request_id>`).
 */
export const retryRenewalCharge = action(
  { name: "memberships.retry_charge", audience: "staff", permission: "memberships.write", input: z.object({ membershipId: z.string().uuid() }), audit: false },
  async (ctx, input) => {
    const m = await lockMembership(ctx.tx, input.membershipId);
    if (m.status !== "past_due") throw new ConflictError(`membership_${m.status}`);
    if (m.cancelAt) throw new ConflictError("membership_ending");
    if (m.dunningAttempt >= 3) throw new ConflictError("retries_exhausted");
    const mandate = await getActiveMandate(ctx.tx, m.personId);
    if (!mandate) throw new ConflictError("no_mandate");
    const attempt = Math.max(2, m.dunningAttempt + 1) as 2 | 3;
    const periodEndOn = brusselsDateKey(m.currentPeriodEndAt);
    await ctx.tx
      .update(memberships)
      .set({ nextChargeAt: ctx.now, version: m.version + 1, updatedAt: ctx.now })
      .where(eq(memberships.id, m.id));
    const job = await ctx.enqueue({
      kind: "memberships.charge_renewal",
      payload: { membershipId: m.id, periodEndOn, attempt },
      key: `${renewalJobKey(m.id, periodEndOn, 1)}:manual:${ctx.requestId}`,
    });
    await ctx.audit({
      action: "memberships.charge_retried",
      entityType: "membership",
      entityId: m.id,
      personId: m.personId,
      oldValue: { dunning_attempt: m.dunningAttempt, next_charge_at: m.nextChargeAt?.toISOString() ?? null },
      newValue: { attempt, next_charge_at: ctx.now.toISOString() },
    });
    return { jobId: job.id, attempt };
  },
);

/** The staff notes of a membership (PII-risk: the audit row records only whether notes are set). */
export const updateMembershipNotes = action(
  { name: "memberships.update_notes", audience: "staff", permission: "memberships.write", input: UpdateMembershipNotesInput, audit: false },
  async (ctx, input) => {
    const m = await membershipVersion(ctx, input.membershipId, input.version);
    const notes = input.notes.trim() || null;
    const [row] = await ctx.tx
      .update(memberships)
      .set({ notes, version: m.version + 1, updatedAt: ctx.now })
      .where(eq(memberships.id, m.id))
      .returning({ version: memberships.version });
    await ctx.audit({
      action: "memberships.notes_changed",
      entityType: "membership",
      entityId: m.id,
      personId: m.personId,
      oldValue: { has_notes: !!m.notes, length: m.notes?.length ?? 0 },
      newValue: { has_notes: !!notes, length: notes?.length ?? 0 },
    });
    return { version: row!.version };
  },
);

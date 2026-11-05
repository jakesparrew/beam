/**
 * R3 referral and partner management (credits rules 60 to 63, section 2 "R3 state machines";
 * credits-P9). Database code behind `actions.ts`, `queries.ts`, `jobs.ts` and `api.ts`.
 *
 * - Codes: one active personal code per person (8 characters of `A-HJ-NP-Z2-9`, created on first
 *   visit to the portal page), partner codes for companies with `is_partner` (staff).
 * - Attribution: first-touch, one row per referred person, from `persons.acquisition` by the job
 *   `credits.attribute_referrals` or by staff. Self-referral (same person, email or phone) and a
 *   person who already paid an order above 0 before attribution are `rejected`.
 * - Qualification: the first paid order above 0 after attribution sets `qualified` with
 *   `qualifies_at = first_paid_at + 14 days`; a full refund before then returns to `pending`.
 * - Rewards: `credits.qualify_referral_rewards` writes the `referral` grants at `qualifies_at`
 *   (keys `grant:referral:<id>:referrer|referee`), or `rejected cap_reached` past the yearly cap.
 * - Commission: every paid order of a partner-attributed person until `commission_until_at`
 *   accrues `round_half_up(net * pct / 100)` (key `commission:<order_id>`); a refund accrues the
 *   negative row (`commission:refund:<refund_id>`). Finance approves and marks paid.
 */
import type { DbOrTx, Tx } from "@beam/db";
import { companies, creditGrants, orders, partnerCommissions, persons, referralAttributions, referralCodes, refunds } from "@beam/db/schema";
import { computeExpiresAt } from "@beam/core/credits";
import { LOCALES, t, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { and, asc, ConflictError, eq, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { rowsOf } from "@/lib/sensitive";
import { grantCredits } from "./ledger";
// `@beam/core/credits` does not re-export `referrals.ts` yet (requested from the owner of its index).
import {
  assertAttributionTransition,
  assertCommissionTransition,
  brusselsMonthStart,
  brusselsYear,
  commissionBase,
  commissionFor,
  commissionUntilFor,
  generateReferralCode,
  isSelfReferral,
  isValidReferralCode,
  normalizeReferralCode,
  qualifiesAtFor,
  referralKeys,
  referralShareUrl,
  REFERRALS_SETTINGS_DEFAULTS,
  refundCommissionBase,
  type PartnerCommissionStatus,
  type ReferralAttributionSource,
  type ReferralReward,
  type ReferralsSettings,
} from "../../../../../packages/core/src/credits/referrals";

export * from "../../../../../packages/core/src/credits/referrals";

// email is loaded on call: its import graph reaches booking, which imports credits' api.
const email = () => import("@/modules/email/api");

export type AttributionRow = typeof referralAttributions.$inferSelect;
export type CodeRow = typeof referralCodes.$inferSelect;

/** The `referrals` setting (its declared default when no row exists or it fails its schema). */
export async function referralsSettings(db: DbOrTx): Promise<ReferralsSettings> {
  try {
    return await getSetting(db, "referrals");
  } catch {
    return structuredClone(REFERRALS_SETTINGS_DEFAULTS);
  }
}

const staffUserId = (ctx: Ctx) => (ctx.actor.kind === "staff" ? ctx.actor.userId : null);
const attributionRef = (id: string) => ({ type: "referral_attribution", id });

// ---------------------------------------------------------------------------
// Codes (rule 60)
// ---------------------------------------------------------------------------

/** Uses of a code: attributions made with it that were not rejected. */
async function codeUses(db: DbOrTx, codeId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(referralAttributions)
    .where(and(eq(referralAttributions.codeId, codeId), sql`${referralAttributions.status} <> 'rejected'`));
  return Number(r?.n ?? 0);
}

/** An active code by its text (any case), with uses left; else null (crm person creation). */
export async function resolveReferralCode(
  db: DbOrTx,
  code: string,
): Promise<{ codeId: string; referrerPersonId: string | null; partnerCompanyId: string | null } | null> {
  const norm = normalizeReferralCode(code);
  if (!isValidReferralCode(norm)) return null;
  const [row] = await db.select().from(referralCodes).where(and(sql`upper(${referralCodes.code}) = ${norm}`, eq(referralCodes.isActive, true)));
  if (!row) return null;
  if (row.maxUses != null && (await codeUses(db, row.id)) >= row.maxUses) return null;
  return { codeId: row.id, referrerPersonId: row.personId, partnerCompanyId: row.partnerCompanyId };
}

async function codeTaken(db: DbOrTx, code: string): Promise<boolean> {
  const [row] = await db.select({ id: referralCodes.id }).from(referralCodes).where(sql`upper(${referralCodes.code}) = ${code}`);
  return !!row;
}

/** A fresh personal code; retries on the (rare) collision. */
async function freshCode(db: DbOrTx): Promise<string> {
  for (let i = 0; i < 20; i += 1) {
    const code = generateReferralCode();
    if (!(await codeTaken(db, code))) return code;
  }
  throw new ConflictError("code_generation_failed");
}

/** The person's active personal code, created on first call (portal, rule 60). */
export async function getOrCreatePersonalCode(tx: Tx, ctx: Ctx, personId: string): Promise<{ codeId: string; code: string; created: boolean }> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`referral_code:person:${personId}`}))`);
  const [existing] = await tx.select().from(referralCodes).where(and(eq(referralCodes.personId, personId), eq(referralCodes.isActive, true)));
  if (existing) return { codeId: existing.id, code: existing.code, created: false };
  const code = await freshCode(tx);
  const [row] = await tx.insert(referralCodes).values({ code, personId, createdByUserId: staffUserId(ctx), createdAt: ctx.now, updatedAt: ctx.now }).returning();
  return { codeId: row!.id, code: row!.code, created: true };
}

export type CreateCodeInput = {
  personId?: string;
  partnerCompanyId?: string;
  code?: string;
  referrerReward?: ReferralReward | null;
  refereeReward?: ReferralReward | null;
  maxUses?: number | null;
};

/** Staff: a partner code (company with `is_partner`) or a personal code; audit `referrals.code_created`. */
export async function createReferralCode(tx: Tx, ctx: Ctx, input: CreateCodeInput): Promise<{ codeId: string; code: string }> {
  if (!!input.personId === !!input.partnerCompanyId) throw new ValidationError("validation", { partnerCompanyId: "one_owner" });
  if (input.partnerCompanyId) {
    const [c] = await tx.select({ isPartner: companies.isPartner }).from(companies).where(eq(companies.id, input.partnerCompanyId));
    if (!c) throw new NotFoundError("company_not_found");
    if (!c.isPartner) throw new ValidationError("not_a_partner", { partnerCompanyId: "not_a_partner" });
  } else {
    const [p] = await tx.select({ erasedAt: persons.erasedAt }).from(persons).where(eq(persons.id, input.personId!));
    if (!p || p.erasedAt) throw new NotFoundError("person_not_found");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`referral_code:person:${input.personId}`}))`);
    const [active] = await tx.select({ id: referralCodes.id }).from(referralCodes).where(and(eq(referralCodes.personId, input.personId!), eq(referralCodes.isActive, true)));
    if (active) throw new ConflictError("code_exists");
  }
  let code: string;
  if (input.code) {
    code = normalizeReferralCode(input.code);
    if (!isValidReferralCode(code)) throw new ValidationError("validation", { code: "invalid_code" });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`referral_code:${code}`}))`);
    if (await codeTaken(tx, code)) throw new ConflictError("code_taken");
  } else {
    code = await freshCode(tx);
  }
  const [row] = await tx
    .insert(referralCodes)
    .values({
      code,
      personId: input.personId ?? null,
      partnerCompanyId: input.partnerCompanyId ?? null,
      referrerReward: input.referrerReward ?? null,
      refereeReward: input.refereeReward ?? null,
      maxUses: input.maxUses ?? null,
      createdByUserId: staffUserId(ctx),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  await ctx.audit({
    action: "referrals.code_created",
    entityType: "referral_code",
    entityId: row!.id,
    personId: input.personId ?? null,
    oldValue: null,
    newValue: { code, partner_company_id: input.partnerCompanyId ?? null, max_uses: input.maxUses ?? null, referrer_reward: input.referrerReward ?? null, referee_reward: input.refereeReward ?? null },
  });
  return { codeId: row!.id, code };
}

export type UpdateCodeInput = {
  codeId: string;
  isActive?: boolean;
  referrerReward?: ReferralReward | null;
  refereeReward?: ReferralReward | null;
  maxUses?: number | null;
};

/** Staff: activate or deactivate a code, change its rewards or use limit; audit `referrals.code_changed`. */
export async function updateReferralCode(tx: Tx, ctx: Ctx, input: UpdateCodeInput): Promise<{ codeId: string; isActive: boolean }> {
  const [row] = await tx.select().from(referralCodes).where(eq(referralCodes.id, input.codeId)).for("update");
  if (!row) throw new NotFoundError("code_not_found");
  const next = {
    isActive: input.isActive ?? row.isActive,
    referrerReward: input.referrerReward === undefined ? row.referrerReward : input.referrerReward,
    refereeReward: input.refereeReward === undefined ? row.refereeReward : input.refereeReward,
    maxUses: input.maxUses === undefined ? row.maxUses : input.maxUses,
  };
  if (next.isActive && !row.isActive && row.personId) {
    const [other] = await tx
      .select({ id: referralCodes.id })
      .from(referralCodes)
      .where(and(eq(referralCodes.personId, row.personId), eq(referralCodes.isActive, true)));
    if (other) throw new ConflictError("code_exists");
  }
  await tx.update(referralCodes).set({ ...next, updatedAt: ctx.now }).where(eq(referralCodes.id, row.id));
  await ctx.audit({
    action: "referrals.code_changed",
    entityType: "referral_code",
    entityId: row.id,
    personId: row.personId,
    oldValue: { is_active: row.isActive, referrer_reward: row.referrerReward, referee_reward: row.refereeReward, max_uses: row.maxUses },
    newValue: { is_active: next.isActive, referrer_reward: next.referrerReward, referee_reward: next.refereeReward, max_uses: next.maxUses },
  });
  return { codeId: row.id, isActive: next.isActive };
}

// ---------------------------------------------------------------------------
// Attribution (rule 61, edge case 28)
// ---------------------------------------------------------------------------

export type AttributeInput = {
  referredPersonId: string;
  codeId?: string;
  referrerPersonId?: string;
  partnerCompanyId?: string;
  source: ReferralAttributionSource;
  /** When the referral happened (default `ctx.now`); the job passes the person's creation time. */
  attributedAt?: Date;
};

export type AttributeResult = { attributionId: string | null; status: "pending" | "qualified" | "rejected"; created: boolean; reason?: string };

async function personContact(db: DbOrTx, id: string) {
  const [p] = await db
    .select({ id: persons.id, email: persons.email, phone: sql<string | null>`coalesce(${persons.phoneE164}, ${persons.phone})`, erasedAt: persons.erasedAt, mergedInto: persons.mergedIntoPersonId })
    .from(persons)
    .where(eq(persons.id, id));
  return p ? { ...p, personId: p.id } : undefined;
}

/** A partner company that may earn commission (`is_partner`). */
async function partnerOk(db: DbOrTx, companyId: string): Promise<boolean> {
  const [c] = await db.select({ isPartner: companies.isPartner }).from(companies).where(eq(companies.id, companyId));
  return !!c?.isPartner;
}

/** Paid orders above 0 of the person, oldest first (`paid_at` set: paid, partially refunded or refunded). */
async function paidOrdersOf(db: DbOrTx, personId: string) {
  return db
    .select({ id: orders.id, paidAt: orders.paidAt, totalCents: orders.totalCents, vatCents: orders.vatCents, status: orders.status })
    .from(orders)
    .where(and(eq(orders.personId, personId), sql`${orders.paidAt} is not null`, sql`${orders.totalCents} > 0`))
    .orderBy(asc(orders.paidAt), asc(orders.id));
}

/**
 * Writes the person's one attribution (first touch). An existing attribution wins (`created:
 * false`). Self-referral and an earlier paid order are stored `rejected`; a referral of oneself by
 * id has no row (the table forbids it). Paid orders made between the referral and this call are
 * applied at once (qualification and commission), so the job's lag loses nothing.
 */
export async function attributeReferral(tx: Tx, ctx: Ctx, input: AttributeInput): Promise<AttributeResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`referral:person:${input.referredPersonId}`}))`);
  const [existing] = await tx.select().from(referralAttributions).where(eq(referralAttributions.referredPersonId, input.referredPersonId));
  if (existing) return { attributionId: existing.id, status: existing.status === "rewarded" ? "qualified" : existing.status, created: false };

  const referred = await personContact(tx, input.referredPersonId);
  if (!referred || referred.erasedAt || referred.mergedInto) throw new NotFoundError("person_not_found");

  let referrerPersonId = input.referrerPersonId ?? null;
  let partnerCompanyId = input.partnerCompanyId ?? null;
  let codeId: string | null = null;
  if (input.codeId) {
    const [code] = await tx.select().from(referralCodes).where(eq(referralCodes.id, input.codeId));
    if (!code) throw new NotFoundError("code_not_found");
    codeId = code.id;
    referrerPersonId ??= code.personId;
    partnerCompanyId ??= code.partnerCompanyId;
  }
  if (partnerCompanyId && !(await partnerOk(tx, partnerCompanyId))) {
    if (input.source === "staff") throw new ValidationError("not_a_partner", { partnerCompanyId: "not_a_partner" });
    partnerCompanyId = null;
  }
  if (!referrerPersonId && !partnerCompanyId) throw new ValidationError("validation", { referrerPersonId: "referrer_required" });

  if (referrerPersonId === input.referredPersonId) {
    if (!partnerCompanyId) {
      await recordRejected(ctx, input.referredPersonId, null, "self_referral");
      return { attributionId: null, status: "rejected", created: false, reason: "self_referral" };
    }
    referrerPersonId = null;
  }
  const referrer = referrerPersonId ? await personContact(tx, referrerPersonId) : undefined;
  if (referrerPersonId && !referrer) throw new NotFoundError("referrer_not_found");

  const attributedAt = input.attributedAt ?? ctx.now;
  const settings = await referralsSettings(tx);
  const paid = await paidOrdersOf(tx, input.referredPersonId);
  let rejectedReason: string | null = null;
  if (referrer && isSelfReferral(referrer, referred)) rejectedReason = "self_referral";
  else if (paid.some((o) => o.paidAt! < attributedAt)) rejectedReason = "already_customer";

  const [row] = await tx
    .insert(referralAttributions)
    .values({
      referredPersonId: input.referredPersonId,
      codeId,
      referrerPersonId,
      partnerCompanyId,
      source: input.source,
      status: rejectedReason ? "rejected" : "pending",
      attributedAt,
      commissionUntilAt: commissionUntilFor(attributedAt, settings.commission_months),
      rejectedReason,
      createdByUserId: staffUserId(ctx),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  const a = row!;
  if (input.source === "staff") {
    await ctx.audit({
      action: "referrals.attributed",
      entityType: "referral_attribution",
      entityId: a.id,
      personId: a.referredPersonId,
      oldValue: null,
      newValue: { status: a.status, code_id: codeId, referrer_person_id: referrerPersonId, partner_company_id: partnerCompanyId, rejected_reason: rejectedReason },
    });
  }
  if (rejectedReason) {
    await recordRejected(ctx, a.referredPersonId, a.id, rejectedReason);
    return { attributionId: a.id, status: "rejected", created: true, reason: rejectedReason };
  }
  await ctx.recordEvent({
    kind: "referral.attributed",
    personId: a.referredPersonId,
    ref: attributionRef(a.id),
    dedupeKey: `referral:${a.id}:attributed`,
    data: { attribution_id: a.id, source: a.source, via_partner: !!partnerCompanyId },
  });
  for (const o of paid) await applyPaidOrder(tx, ctx, o.id);
  const [after] = await tx.select({ status: referralAttributions.status }).from(referralAttributions).where(eq(referralAttributions.id, a.id));
  return { attributionId: a.id, status: after!.status === "qualified" ? "qualified" : "pending", created: true };
}

async function recordRejected(ctx: Ctx, personId: string, attributionId: string | null, reason: string): Promise<void> {
  await ctx.recordEvent({
    kind: "referral.rejected",
    personId,
    ...(attributionId ? { ref: attributionRef(attributionId) } : {}),
    dedupeKey: `referral:${attributionId ?? `person:${personId}`}:rejected`,
    data: { attribution_id: attributionId, reason },
  });
}

/** Staff: `pending` → `rejected` with a reason; audit `referrals.attribution_rejected`. */
export async function rejectAttribution(tx: Tx, ctx: Ctx, input: { attributionId: string; reason: string }): Promise<{ attributionId: string; status: "rejected" }> {
  const [a] = await tx.select().from(referralAttributions).where(eq(referralAttributions.id, input.attributionId)).for("update");
  if (!a) throw new NotFoundError("attribution_not_found");
  assertAttributionTransition(a.status, "rejected");
  if (a.status !== "pending") throw new ConflictError("attribution_not_pending");
  await tx.update(referralAttributions).set({ status: "rejected", rejectedReason: input.reason, updatedAt: ctx.now }).where(eq(referralAttributions.id, a.id));
  await ctx.audit({
    action: "referrals.attribution_rejected",
    entityType: "referral_attribution",
    entityId: a.id,
    personId: a.referredPersonId,
    oldValue: { status: a.status },
    newValue: { status: "rejected" },
  });
  await recordRejected(ctx, a.referredPersonId, a.id, "staff");
  return { attributionId: a.id, status: "rejected" };
}

// ---------------------------------------------------------------------------
// Paid orders and refunds (rules 62 and 63; commerce's transactions)
// ---------------------------------------------------------------------------

async function lockAttributionOf(tx: DbOrTx, personId: string): Promise<AttributionRow | undefined> {
  const [a] = await tx.select().from(referralAttributions).where(eq(referralAttributions.referredPersonId, personId)).for("update");
  return a;
}

/** The order's qualification and commission effects; idempotent (status checks and the commission key). */
async function applyPaidOrder(tx: Tx, ctx: Ctx, orderId: string): Promise<void> {
  const [o] = await tx.select().from(orders).where(eq(orders.id, orderId));
  if (!o?.personId || !o.paidAt) return;
  const a = await lockAttributionOf(tx, o.personId);
  if (!a || a.status === "rejected" || o.paidAt < a.attributedAt) return;
  const settings = await referralsSettings(tx);

  if (a.status === "pending" && o.totalCents > 0 && o.status !== "refunded") {
    assertAttributionTransition("pending", "qualified");
    await tx
      .update(referralAttributions)
      .set({ status: "qualified", firstPaidOrderId: o.id, firstPaidAt: o.paidAt, qualifiesAt: qualifiesAtFor(o.paidAt, settings.qualification_days), updatedAt: ctx.now })
      .where(eq(referralAttributions.id, a.id));
  }

  if (!a.partnerCompanyId || !a.commissionUntilAt || o.paidAt >= a.commissionUntilAt) return;
  const [company] = await tx
    .select({ isPartner: companies.isPartner, pct: companies.partnerCommissionPct })
    .from(companies)
    .where(eq(companies.id, a.partnerCompanyId));
  if (!company?.isPartner || company.pct == null) return;
  const base = commissionBase(o);
  if (base <= 0) return;
  await tx
    .insert(partnerCommissions)
    .values({
      partnerCompanyId: a.partnerCompanyId,
      attributionId: a.id,
      orderId: o.id,
      baseCents: base,
      commissionPct: company.pct,
      amountCents: commissionFor({ baseCents: base, pct: company.pct }),
      periodMonth: brusselsMonthStart(o.paidAt),
      idempotencyKey: referralKeys.commission(o.id),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing({ target: partnerCommissions.idempotencyKey });
}

/** Commerce's paid transaction (commerce rule 32, from R3): first paid order → `qualified`; partner commission accrual. */
export async function onOrderPaidForReferrals(tx: Tx, ctx: Ctx, input: { orderId: string }): Promise<void> {
  await applyPaidOrder(tx, ctx, input.orderId);
}

/**
 * Commerce's refund transaction: a negative commission row for an order that accrued one (the
 * refunded share of its net total, the original rate), and, when the qualifying order is now
 * fully refunded before `qualifies_at`, the attribution returns to `pending` (columns cleared).
 */
export async function onOrderRefundedForReferrals(tx: Tx, ctx: Ctx, input: { orderId: string; refundId: string }): Promise<void> {
  const [o] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (!o?.personId) return;
  const [refund] = await tx.select().from(refunds).where(and(eq(refunds.id, input.refundId), eq(refunds.orderId, o.id)));
  if (!refund) throw new NotFoundError("refund_not_found");
  const a = await lockAttributionOf(tx, o.personId);
  if (!a) return;

  if (a.status === "qualified" && a.firstPaidOrderId === o.id && a.qualifiesAt && ctx.now < a.qualifiesAt) {
    const [sum] = await tx
      .select({ cents: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
      .from(refunds)
      .where(and(eq(refunds.orderId, o.id), sql`${refunds.status} <> 'failed'`));
    if (o.status === "refunded" || Number(sum?.cents ?? 0) >= o.totalCents) {
      assertAttributionTransition("qualified", "pending");
      await tx
        .update(referralAttributions)
        .set({ status: "pending", firstPaidOrderId: null, firstPaidAt: null, qualifiesAt: null, updatedAt: ctx.now })
        .where(eq(referralAttributions.id, a.id));
    }
  }

  const [accrual] = await tx.select().from(partnerCommissions).where(eq(partnerCommissions.idempotencyKey, referralKeys.commission(o.id)));
  if (!accrual) return;
  const base = refundCommissionBase({ refundCents: refund.amountCents, orderTotalCents: o.totalCents, orderVatCents: o.vatCents });
  if (base >= 0) return;
  await tx
    .insert(partnerCommissions)
    .values({
      partnerCompanyId: accrual.partnerCompanyId,
      attributionId: accrual.attributionId,
      orderId: o.id,
      refundId: refund.id,
      baseCents: base,
      commissionPct: accrual.commissionPct,
      amountCents: commissionFor({ baseCents: base, pct: accrual.commissionPct }),
      periodMonth: brusselsMonthStart(ctx.now),
      idempotencyKey: referralKeys.commissionRefund(refund.id),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .onConflictDoNothing({ target: partnerCommissions.idempotencyKey });
}

// ---------------------------------------------------------------------------
// Rewards (rule 62; job `credits.qualify_referral_rewards`)
// ---------------------------------------------------------------------------

/** Attributions handled per run of the reward job. */
export const QUALIFY_CHUNK = 500;

const rewardLabel = () => Object.fromEntries(LOCALES.map((l) => [l, t(l, "credits.labels.referral_reward")])) as Record<Locale, string>;

async function personLocale(db: DbOrTx, personId: string): Promise<Locale> {
  const [p] = await db.select({ locale: persons.locale }).from(persons).where(eq(persons.id, personId));
  return p?.locale ?? "nl-BE";
}

const appUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;

/** The share link of a personal code: the site home in the reader's language with `?ref=<CODE>` (site captures it). */
export function shareUrlFor(code: string, locale: Locale): string {
  return referralShareUrl(process.env.APP_URL ?? "http://localhost:3000", URL_SEGMENT[locale], code);
}

/** One `referral` grant for `personId`, linked to the attribution; idempotent on its key. */
async function writeReward(tx: Tx, ctx: Ctx, a: AttributionRow, role: "referrer" | "referee", personId: string, reward: ReferralReward): Promise<string> {
  const key = role === "referrer" ? referralKeys.referrerReward(a.id) : referralKeys.refereeReward(a.id);
  const { grantId, created } = await grantCredits(tx, ctx, {
    personId,
    kind: reward.credit_kind,
    units: reward.units,
    source: "referral",
    label: rewardLabel(),
    startsAt: ctx.now,
    expiresAt: computeExpiresAt(ctx.now, reward.validity_days),
    reason: role === "referrer" ? "referral_reward" : "referral_welcome",
    key,
  });
  await tx.update(creditGrants).set({ referralAttributionId: a.id, updatedAt: ctx.now }).where(eq(creditGrants.id, grantId));
  if (created) {
    await ctx.recordEvent({
      kind: "referral.rewarded",
      personId,
      ref: attributionRef(a.id),
      dedupeKey: `referral:${a.id}:rewarded:${role}`,
      data: { attribution_id: a.id, role, grant_id: grantId },
    });
    const locale = await personLocale(tx, personId);
    await (await email()).sendTransactional(ctx, {
      template: "credits.referral_reward",
      personId,
      locale,
      data: { attributionId: a.id, role, creditKind: reward.credit_kind, units: reward.units, expiresAt: computeExpiresAt(ctx.now, reward.validity_days)?.toISOString() ?? null, accountUrl: appUrl(`/${locale}/account/packages`) },
      key: `credits:referral_reward:${a.id}:${role}`,
    });
  }
  return grantId;
}

/** Rewarded referrals of a referrer in the Brussels calendar year of `at` (the cap of rule 62). */
async function rewardedThisYear(db: DbOrTx, referrerPersonId: string, at: Date): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(referralAttributions)
    .where(
      and(
        eq(referralAttributions.referrerPersonId, referrerPersonId),
        eq(referralAttributions.status, "rewarded"),
        sql`extract(year from ${referralAttributions.qualifiesAt} at time zone 'Europe/Brussels') = ${brusselsYear(at)}`,
      ),
    );
  return Number(r?.n ?? 0);
}

/**
 * One due attribution under its row lock: still `qualified` and due, the qualifying order not
 * refunded in full; then `rejected cap_reached` past the yearly cap, else `rewarded` with the
 * referrer grant (code reward, else the setting; none for a partner-only attribution) and the
 * referee grant (code reward, else the setting; for a partner-only attribution only a code reward).
 */
export async function qualifyAttribution(tx: Tx, ctx: Ctx, attributionId: string, settings: ReferralsSettings): Promise<"rewarded" | "rejected" | "pending" | "skipped"> {
  const [a] = await tx.select().from(referralAttributions).where(eq(referralAttributions.id, attributionId)).for("update");
  if (!a || a.status !== "qualified" || !a.qualifiesAt || a.qualifiesAt > ctx.now) return "skipped";
  const [order] = a.firstPaidOrderId ? await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, a.firstPaidOrderId)) : [];
  if (!order || order.status === "refunded") {
    assertAttributionTransition("qualified", "pending");
    await tx
      .update(referralAttributions)
      .set({ status: "pending", firstPaidOrderId: null, firstPaidAt: null, qualifiesAt: null, updatedAt: ctx.now })
      .where(eq(referralAttributions.id, a.id));
    return "pending";
  }
  if (a.referrerPersonId) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`referral:referrer:${a.referrerPersonId}`}))`);
    if ((await rewardedThisYear(tx, a.referrerPersonId, a.qualifiesAt)) >= settings.yearly_cap) {
      assertAttributionTransition("qualified", "rejected");
      await tx.update(referralAttributions).set({ status: "rejected", rejectedReason: "cap_reached", updatedAt: ctx.now }).where(eq(referralAttributions.id, a.id));
      await recordRejected(ctx, a.referredPersonId, a.id, "cap_reached");
      return "rejected";
    }
  }
  const [code] = a.codeId ? await tx.select().from(referralCodes).where(eq(referralCodes.id, a.codeId)) : [];
  const referrerReward = a.referrerPersonId ? (code?.referrerReward ?? settings.referrer) : null;
  const refereeReward = code?.refereeReward ?? (a.referrerPersonId ? settings.referee : null);
  assertAttributionTransition("qualified", "rewarded");
  const referrerGrantId = referrerReward && a.referrerPersonId ? await writeReward(tx, ctx, a, "referrer", a.referrerPersonId, referrerReward) : null;
  const refereeGrantId = refereeReward ? await writeReward(tx, ctx, a, "referee", a.referredPersonId, refereeReward) : null;
  await tx
    .update(referralAttributions)
    .set({ status: "rewarded", referrerRewardGrantId: referrerGrantId, refereeRewardGrantId: refereeGrantId, updatedAt: ctx.now })
    .where(eq(referralAttributions.id, a.id));
  if (!referrerGrantId && !refereeGrantId) {
    await ctx.recordEvent({
      kind: "referral.rewarded",
      personId: a.referredPersonId,
      ref: attributionRef(a.id),
      dedupeKey: `referral:${a.id}:rewarded:none`,
      data: { attribution_id: a.id, role: "referee", grant_id: null },
    });
  }
  return "rewarded";
}

/** Due `qualified` attributions (`qualifies_at <= now`), oldest first. */
export async function dueQualifications(db: DbOrTx, now: Date, limit = QUALIFY_CHUNK): Promise<string[]> {
  const rows = await db
    .select({ id: referralAttributions.id })
    .from(referralAttributions)
    .where(and(eq(referralAttributions.status, "qualified"), sql`${referralAttributions.qualifiesAt} <= ${now.toISOString()}::timestamptz`))
    .orderBy(asc(referralAttributions.qualifiesAt), asc(referralAttributions.id))
    .limit(limit);
  return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Attribution from acquisition (job `credits.attribute_referrals`)
// ---------------------------------------------------------------------------

export type AttributeCursor = { createdAt: string; id: string };

/** Persons handled per run of the attribution job. */
export const ATTRIBUTE_CHUNK = 500;

/** The cursor of the last succeeded run (`jobs.result.cursor`), else null (from the beginning). */
export async function lastAttributeCursor(db: DbOrTx): Promise<AttributeCursor | null> {
  const rows = rowsOf<{ cursor: AttributeCursor | null }>(
    await db.execute(sql`
      select result->'cursor' as cursor from jobs
      where kind = 'credits.attribute_referrals' and status = 'succeeded' and result ? 'cursor' and jsonb_typeof(result->'cursor') = 'object'
      order by finished_at desc nulls last, id desc limit 1`),
  );
  const c = rows[0]?.cursor;
  return c && typeof c.createdAt === "string" && typeof c.id === "string" ? c : null;
}

type Candidate = { id: string; created_at: string; referral_code: string | null; referrer_person_id: string | null; partner_company_id: string | null };

/** Persons created after the cursor whose acquisition names a code, a referrer or a partner. */
export async function attributionCandidates(db: DbOrTx, cursor: AttributeCursor | null, limit = ATTRIBUTE_CHUNK): Promise<Candidate[]> {
  const after = cursor ? sql`and (p.created_at, p.id) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)` : sql``;
  return rowsOf<Candidate>(
    await db.execute(sql`
      select p.id::text as id, to_char(p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
             p.acquisition->>'referral_code' as referral_code, p.acquisition->>'referrer_person_id' as referrer_person_id,
             coalesce(p.acquisition->>'partner_company_id', p.partner_company_id::text) as partner_company_id
      from persons p
      where p.erased_at is null and p.merged_into_person_id is null
        and (p.acquisition ? 'referral_code' or p.acquisition ? 'referrer_person_id' or p.acquisition ? 'partner_company_id')
        ${after}
      order by p.created_at, p.id limit ${limit}`),
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One candidate in its own savepoint; returns the outcome for the job result. */
export async function attributeCandidate(tx: Tx, ctx: Ctx, c: Candidate): Promise<"attributed" | "rejected" | "existing" | "skipped"> {
  let codeId: string | undefined;
  let referrer = c.referrer_person_id && UUID_RE.test(c.referrer_person_id) ? c.referrer_person_id : undefined;
  let partner = c.partner_company_id && UUID_RE.test(c.partner_company_id) ? c.partner_company_id : undefined;
  if (c.referral_code) {
    const [code] = await tx.select().from(referralCodes).where(sql`upper(${referralCodes.code}) = ${normalizeReferralCode(c.referral_code)}`);
    if (code) {
      codeId = code.id;
      referrer = code.personId ?? referrer;
      partner = code.partnerCompanyId ?? partner;
    }
  }
  if (referrer) {
    const [r] = await tx.select({ id: persons.id }).from(persons).where(eq(persons.id, referrer));
    if (!r) referrer = undefined;
  }
  if (!codeId && !referrer && !partner) return "skipped";
  try {
    const r = await tx.transaction((sp) =>
      attributeReferral(sp, ctx, {
        referredPersonId: c.id,
        ...(codeId ? { codeId } : {}),
        ...(referrer ? { referrerPersonId: referrer } : {}),
        ...(partner ? { partnerCompanyId: partner } : {}),
        source: codeId ? "code" : "link",
        attributedAt: new Date(c.created_at),
      }),
    );
    if (!r.created) return r.attributionId ? "existing" : "rejected";
    return r.status === "rejected" ? "rejected" : "attributed";
  } catch (error) {
    if (error instanceof ValidationError || error instanceof NotFoundError) return "skipped";
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Commission statuses (rule 63, `referrals.manage`)
// ---------------------------------------------------------------------------

/** Finance: `approved`, `paid` or `void` for up to 500 rows; one audit row per changed row. */
export async function setCommissionStatus(
  tx: Tx,
  ctx: Ctx,
  input: { commissionIds: string[]; status: Exclude<PartnerCommissionStatus, "accrued">; note?: string },
): Promise<{ changed: number }> {
  const ids = [...new Set(input.commissionIds)].sort();
  const rows = await tx
    .select()
    .from(partnerCommissions)
    .where(sql`${partnerCommissions.id} = any(${`{${ids.join(",")}}`}::uuid[])`)
    .orderBy(asc(partnerCommissions.id))
    .for("update");
  if (rows.length !== ids.length) throw new NotFoundError("commission_not_found");
  for (const r of rows) assertCommissionTransition(r.status, input.status);
  for (const r of rows) {
    await tx
      .update(partnerCommissions)
      .set({
        status: input.status,
        ...(input.status === "approved" ? { approvedByUserId: staffUserId(ctx) } : {}),
        ...(input.status === "paid" ? { paidAt: ctx.now } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        updatedAt: ctx.now,
      })
      .where(eq(partnerCommissions.id, r.id));
    await ctx.audit({
      action: "referrals.commission_status_changed",
      entityType: "partner_commission",
      entityId: r.id,
      personId: null,
      oldValue: { status: r.status, amount_cents: r.amountCents },
      newValue: { status: input.status, amount_cents: r.amountCents },
    });
  }
  return { changed: rows.length };
}

// ---------------------------------------------------------------------------
// Merge (rule 35: `referral_codes` and `referral_attributions` are `skip` in crm's repoint)
// ---------------------------------------------------------------------------

/**
 * Moves the loser's codes and attributions to the winner inside crm's merge transaction. The
 * winner keeps one active personal code (the loser's is deactivated when both have one); the
 * earlier attribution of the two referred persons is kept (first touch), the other deleted; an
 * attribution that would make the winner their own referrer loses the referrer, or is deleted
 * when no partner is left on it.
 */
export async function mergeReferrals(tx: Tx, ctx: Ctx, winner: string, loser: string): Promise<void> {
  const now = sql`${ctx.now.toISOString()}::timestamptz`;
  const w = sql`${winner}::uuid`;
  const l = sql`${loser}::uuid`;
  await tx.execute(sql`
    update referral_codes set is_active = false, updated_at = ${now}
    where person_id = ${l} and is_active and exists (select 1 from referral_codes x where x.person_id = ${w} and x.is_active)`);
  await tx.execute(sql`update referral_codes set person_id = ${w}, updated_at = ${now} where person_id = ${l}`);

  const both = await tx
    .select()
    .from(referralAttributions)
    .where(sql`${referralAttributions.referredPersonId} in (${w}, ${l})`)
    .orderBy(asc(referralAttributions.attributedAt), asc(referralAttributions.id))
    .for("update");
  if (both.length === 2) await tx.delete(referralAttributions).where(eq(referralAttributions.id, both[1]!.id));
  // A self-referral after the merge: drop the referrer, or the row when it has no partner.
  await tx.execute(sql`
    delete from referral_attributions
    where partner_company_id is null
      and ((referred_person_id in (${w}, ${l}) and referrer_person_id in (${w}, ${l})))`);
  await tx.execute(sql`
    update referral_attributions set referrer_person_id = null, updated_at = ${now}
    where referred_person_id in (${w}, ${l}) and referrer_person_id in (${w}, ${l})`);
  await tx.execute(sql`update referral_attributions set referred_person_id = ${w}, updated_at = ${now} where referred_person_id = ${l}`);
  await tx.execute(sql`update referral_attributions set referrer_person_id = ${w}, updated_at = ${now} where referrer_person_id = ${l}`);
}

// ---------------------------------------------------------------------------
// Reads (queries.ts): portal, staff tabs, partner figures
// ---------------------------------------------------------------------------

export type MyReferrals = {
  code: string | null;
  referredCount: number;
  rewards: { grantId: string; creditKind: string; units: number; grantedAt: Date }[];
};

/** Portal (own data): the active personal code, friends referred (count only) and rewards received. */
export async function getMyReferrals(db: DbOrTx, personId: string): Promise<MyReferrals> {
  const [code] = await db
    .select({ code: referralCodes.code })
    .from(referralCodes)
    .where(and(eq(referralCodes.personId, personId), eq(referralCodes.isActive, true)));
  const [count] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(referralAttributions)
    .where(and(eq(referralAttributions.referrerPersonId, personId), sql`${referralAttributions.status} <> 'rejected'`));
  const rewards = await db
    .select({ grantId: creditGrants.id, creditKind: creditGrants.creditKind, units: creditGrants.unitsGranted, grantedAt: creditGrants.createdAt })
    .from(creditGrants)
    .where(and(eq(creditGrants.personId, personId), eq(creditGrants.source, "referral")))
    .orderBy(sql`${creditGrants.createdAt} desc`);
  return { code: code?.code ?? null, referredCount: Number(count?.n ?? 0), rewards };
}

export type CodeListRow = {
  id: string;
  code: string;
  personId: string | null;
  personName: string | null;
  partnerCompanyId: string | null;
  companyName: string | null;
  isActive: boolean;
  maxUses: number | null;
  uses: number;
  referrerReward: ReferralReward | null;
  refereeReward: ReferralReward | null;
  createdAt: Date;
};

/** Staff: codes with owner and uses, partner codes first, newest first. */
export async function listReferralCodes(db: DbOrTx, opts: { limit?: number } = {}): Promise<CodeListRow[]> {
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select c.id::text, c.code, c.person_id::text, nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') as person_name,
             c.partner_company_id::text, co.name as company_name, c.is_active, c.max_uses, c.referrer_reward, c.referee_reward, c.created_at,
             (select count(*)::int from referral_attributions a where a.code_id = c.id and a.status <> 'rejected') as uses
      from referral_codes c left join persons p on p.id = c.person_id left join companies co on co.id = c.partner_company_id
      order by (c.partner_company_id is null), c.created_at desc, c.id limit ${opts.limit ?? 200}`),
  );
  return rows.map((r) => ({
    id: String(r.id),
    code: String(r.code),
    personId: (r.person_id as string | null) ?? null,
    personName: (r.person_name as string | null) ?? null,
    partnerCompanyId: (r.partner_company_id as string | null) ?? null,
    companyName: (r.company_name as string | null) ?? null,
    isActive: Boolean(r.is_active),
    maxUses: r.max_uses == null ? null : Number(r.max_uses),
    uses: Number(r.uses ?? 0),
    referrerReward: (r.referrer_reward as ReferralReward | null) ?? null,
    refereeReward: (r.referee_reward as ReferralReward | null) ?? null,
    createdAt: new Date(String(r.created_at)),
  }));
}

export type AttributionListRow = {
  id: string;
  referredPersonId: string;
  referredName: string | null;
  referrerPersonId: string | null;
  referrerName: string | null;
  partnerCompanyId: string | null;
  companyName: string | null;
  code: string | null;
  source: string;
  status: AttributionRow["status"];
  attributedAt: Date;
  firstPaidAt: Date | null;
  qualifiesAt: Date | null;
  rejectedReason: string | null;
  referrerRewardGrantId: string | null;
};

const dateOrNull = (v: unknown) => (v == null ? null : v instanceof Date ? v : new Date(v as string));

/** Staff: attributions, newest first; optional status filter. */
export async function listAttributions(db: DbOrTx, opts: { status?: AttributionRow["status"]; limit?: number } = {}): Promise<AttributionListRow[]> {
  const where = opts.status ? sql`where a.status = ${opts.status}` : sql``;
  const name = (alias: string) => sql.raw(`nullif(trim(coalesce(${alias}.first_name, '') || ' ' || coalesce(${alias}.last_name, '')), '')`);
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select a.id::text, a.referred_person_id::text, ${name("rp")} as referred_name, a.referrer_person_id::text, ${name("fp")} as referrer_name,
             a.partner_company_id::text, co.name as company_name, c.code, a.source::text, a.status::text, a.attributed_at, a.first_paid_at,
             a.qualifies_at, a.rejected_reason, a.referrer_reward_grant_id::text
      from referral_attributions a
      left join persons rp on rp.id = a.referred_person_id
      left join persons fp on fp.id = a.referrer_person_id
      left join companies co on co.id = a.partner_company_id
      left join referral_codes c on c.id = a.code_id
      ${where}
      order by a.attributed_at desc, a.id limit ${opts.limit ?? 200}`),
  );
  return rows.map((r) => ({
    id: String(r.id),
    referredPersonId: String(r.referred_person_id),
    referredName: (r.referred_name as string | null) ?? null,
    referrerPersonId: (r.referrer_person_id as string | null) ?? null,
    referrerName: (r.referrer_name as string | null) ?? null,
    partnerCompanyId: (r.partner_company_id as string | null) ?? null,
    companyName: (r.company_name as string | null) ?? null,
    code: (r.code as string | null) ?? null,
    source: String(r.source),
    status: String(r.status) as AttributionRow["status"],
    attributedAt: new Date(String(r.attributed_at)),
    firstPaidAt: dateOrNull(r.first_paid_at),
    qualifiesAt: dateOrNull(r.qualifies_at),
    rejectedReason: (r.rejected_reason as string | null) ?? null,
    referrerRewardGrantId: (r.referrer_reward_grant_id as string | null) ?? null,
  }));
}

export type CommissionListRow = {
  id: string;
  partnerCompanyId: string;
  companyName: string | null;
  orderId: string;
  orderReference: string | null;
  refundId: string | null;
  baseCents: number;
  commissionPct: string;
  amountCents: number;
  status: PartnerCommissionStatus;
  periodMonth: string;
  paidAt: Date | null;
};

/** Staff: commission rows, newest month first; optional status and partner filters. */
export async function listCommissions(
  db: DbOrTx,
  opts: { status?: PartnerCommissionStatus; partnerCompanyId?: string; limit?: number } = {},
): Promise<CommissionListRow[]> {
  const filters = [
    opts.status ? sql`pc.status = ${opts.status}` : null,
    opts.partnerCompanyId ? sql`pc.partner_company_id = ${opts.partnerCompanyId}::uuid` : null,
  ].filter((f): f is NonNullable<typeof f> => !!f);
  const where = filters.length ? sql`where ${sql.join(filters, sql` and `)}` : sql``;
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select pc.id::text, pc.partner_company_id::text, co.name as company_name, pc.order_id::text, o.reference as order_reference,
             pc.refund_id::text, pc.base_cents, pc.commission_pct::text, pc.amount_cents, pc.status::text,
             to_char(pc.period_month, 'YYYY-MM-DD') as period_month, pc.paid_at
      from partner_commissions pc left join companies co on co.id = pc.partner_company_id left join orders o on o.id = pc.order_id
      ${where}
      order by pc.period_month desc, pc.created_at desc, pc.id limit ${opts.limit ?? 500}`),
  );
  return rows.map((r) => ({
    id: String(r.id),
    partnerCompanyId: String(r.partner_company_id),
    companyName: (r.company_name as string | null) ?? null,
    orderId: String(r.order_id),
    orderReference: (r.order_reference as string | null) ?? null,
    refundId: (r.refund_id as string | null) ?? null,
    baseCents: Number(r.base_cents),
    commissionPct: String(r.commission_pct),
    amountCents: Number(r.amount_cents),
    status: String(r.status) as PartnerCommissionStatus,
    periodMonth: String(r.period_month),
    paidAt: dateOrNull(r.paid_at),
  }));
}

export type PartnerPerformanceRow = {
  partnerCompanyId: string;
  companyName: string | null;
  periodMonth: string;
  referredCount: number;
  customersCount: number;
  revenueCents: number;
  commissionAccruedCents: number;
  commissionPaidCents: number;
};

/** `v_partner_performance`, newest month first; `companyId` limits to one partner (aggregates only, no names of persons). */
export async function getPartnerPerformance(db: DbOrTx, companyId: string | null, opts: { limit?: number } = {}): Promise<PartnerPerformanceRow[]> {
  const where = companyId ? sql`where v.partner_company_id = ${companyId}::uuid` : sql``;
  const rows = rowsOf<Record<string, unknown>>(
    await db.execute(sql`
      select v.partner_company_id::text, co.name as company_name, to_char(v.period_month, 'YYYY-MM-DD') as period_month,
             v.referred_count, v.customers_count, v.revenue_cents, v.commission_accrued_cents, v.commission_paid_cents
      from v_partner_performance v left join companies co on co.id = v.partner_company_id
      ${where}
      order by v.period_month desc, co.name nulls last limit ${opts.limit ?? 240}`),
  );
  return rows.map((r) => ({
    partnerCompanyId: String(r.partner_company_id),
    companyName: (r.company_name as string | null) ?? null,
    periodMonth: String(r.period_month),
    referredCount: Number(r.referred_count),
    customersCount: Number(r.customers_count),
    revenueCents: Number(r.revenue_cents),
    commissionAccruedCents: Number(r.commission_accrued_cents),
    commissionPaidCents: Number(r.commission_paid_cents),
  }));
}

/** The partner's own codes (code text, active, uses), without any person data. */
export async function listPartnerCodes(db: DbOrTx, companyId: string): Promise<{ code: string; isActive: boolean; uses: number }[]> {
  const rows = rowsOf<{ code: string; is_active: boolean; uses: number }>(
    await db.execute(sql`
      select c.code, c.is_active, (select count(*)::int from referral_attributions a where a.code_id = c.id and a.status <> 'rejected') as uses
      from referral_codes c where c.partner_company_id = ${companyId}::uuid order by c.created_at, c.id`),
  );
  return rows.map((r) => ({ code: r.code, isActive: Boolean(r.is_active), uses: Number(r.uses) }));
}

/** Partner companies (`is_partner`), for the staff code form. */
export async function listPartnerCompanies(db: DbOrTx): Promise<{ id: string; name: string; commissionPct: string | null }[]> {
  return db
    .select({ id: companies.id, name: companies.name, commissionPct: companies.partnerCommissionPct })
    .from(companies)
    .where(eq(companies.isPartner, true))
    .orderBy(asc(companies.name));
}

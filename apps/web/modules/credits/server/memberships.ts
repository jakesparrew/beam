/**
 * The membership service (credits spec section 2 "Membership status machine", rules 44 to 57,
 * edge cases 8 to 13 and 31; credits-P4). Every write first locks the membership row
 * (`SELECT ... FOR UPDATE`), re-checks the status against `assertMembershipTransition`, and bumps
 * `version`. Inclusion grants (rule 46) are ledger grants of source `membership`, written under
 * the membership lock with the key `grant:membership:<id>:<period start date>:<kind>`. Provider
 * work goes through commerce (`createRecurringCharge`, `createRenewalLinkOrder`,
 * `getPayLinkForOrder`, `cancelRenewalOrder`) inside the caller's transaction; emails through
 * `email.sendTransactional`; alerts through platform's `notifySlack`. Reached only through
 * `api.ts`, `jobs.ts` and (credits-P6, P7) `actions.ts`.
 */
import type { DbOrTx, Tx } from "@beam/db";
import {
  activityEvents,
  creditGrants,
  membershipPeriods,
  membershipPlanInclusions,
  memberships,
  orderLines,
  orders,
  persons,
  priceVersions,
  products,
  vCreditGrantBalances,
} from "@beam/db/schema";
import {
  addCalendarDays,
  anchorDayOf,
  assertMembershipTransition,
  brusselsDateKey,
  brusselsDateOf,
  calendarDaysBetween,
  dunningSchedule,
  nextPeriod,
  renewalLeadDates,
  startOfDayIn,
  type CreditKind,
  type CreditsSettings,
  type MembershipEndReason,
  type MembershipStatus,
} from "@beam/core/credits";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import { and, asc, ConflictError, desc, eq, gte, inArray, isNotNull, lt, lte, NotFoundError, or, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { notifySlack } from "@/lib/alerts";
import { cancelRenewalOrder, createRecurringCharge, createRenewalLinkOrder, getActiveMandate, getPayLinkForOrder } from "@/modules/commerce/api";
import { createTask } from "@/modules/crm/api";
import { sendTransactional } from "@/modules/email/api";
import { balanceOf, creditsSettings, entryByKey, extend, lockGrants, setGrantStatus, writeEntry } from "./ledger";

export type MembershipRow = typeof memberships.$inferSelect;
type Interval = MembershipRow["interval"];
type Requester = "customer" | "staff";

/** The six membership templates of credits spec section 8 (registry keys `credits.<name>`). */
export type MembershipTemplate =
  | "membership_started"
  | "membership_renewal_reminder"
  | "membership_renewed"
  | "membership_payment_failed"
  | "membership_expired"
  | "membership_cancel_confirmed";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIVE: MembershipStatus[] = ["active", "past_due"];

const membershipRef = (id: string) => ({ type: "membership", id });
const dateKey = (d: Date) => brusselsDateKey(d);
const appUrl = (path: string) => `${(process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}${path}`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Locks one membership `FOR UPDATE`; `NotFoundError` when it does not exist. */
export async function lockMembership(tx: DbOrTx, id: string): Promise<MembershipRow> {
  if (!UUID_RE.test(id)) throw new NotFoundError("membership_not_found");
  const [m] = await tx.select().from(memberships).where(eq(memberships.id, id)).for("update");
  if (!m) throw new NotFoundError("membership_not_found");
  return m;
}

/** Serialises writers on one logical key (a person's memberships, an order) inside their transactions. */
async function lockKey(tx: DbOrTx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/** A staff or customer form's `version` must match the row (stale -> `conflict`). */
function checkVersion(m: MembershipRow, version: number | undefined): void {
  if (version !== undefined && version !== m.version) throw new ConflictError("stale_version");
}

/** Updates a locked membership, bumping `version` and `updated_at`. */
async function update(tx: DbOrTx, ctx: Ctx, m: MembershipRow, patch: Partial<typeof memberships.$inferInsert>): Promise<MembershipRow> {
  const [row] = await tx
    .update(memberships)
    .set({ ...patch, version: m.version + 1, updatedAt: ctx.now })
    .where(eq(memberships.id, m.id))
    .returning();
  return row!;
}

/** Moves a locked membership to `to` after checking the status machine; ending states stamp `ended_at`. */
async function transition(
  tx: DbOrTx,
  ctx: Ctx,
  m: MembershipRow,
  to: MembershipStatus,
  patch: Partial<typeof memberships.$inferInsert> = {},
  endReason: MembershipEndReason | null = null,
): Promise<MembershipRow> {
  assertMembershipTransition(m.status, to, { endReason: m.status === "expired" ? m.endReason : endReason });
  const ending = to === "cancelled" || to === "expired";
  return update(tx, ctx, m, {
    ...patch,
    status: to,
    endReason: ending ? endReason : null,
    endedAt: ending ? ctx.now : null,
    ...(ending ? { nextChargeAt: null } : {}),
  });
}

/** `at` moved `days` Brussels calendar days at the same wall-clock time (DST-safe). */
export function shiftDays(at: Date, days: number): Date {
  const date = brusselsDateOf(at);
  const offset = at.getTime() - startOfDayIn(date).getTime();
  return new Date(startOfDayIn(addCalendarDays(date, days)).getTime() + offset);
}

/** One interval before `end` (calendar month or year in Brussels, clamped), for imports. */
export function periodStartBefore(end: Date, interval: Interval): Date {
  const d = brusselsDateOf(end);
  let { year, month } = d;
  if (interval === "month") {
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
  } else year -= 1;
  const day = Math.min(d.day, new Date(Date.UTC(year, month, 0)).getUTCDate());
  const offset = end.getTime() - startOfDayIn(d).getTime();
  return new Date(startOfDayIn({ year, month, day }).getTime() + offset);
}

/** 00:00 Brussels of the day of `at` and of the next day. */
function brusselsDayWindow(at: Date): { from: Date; to: Date } {
  const d = brusselsDateOf(at);
  return { from: startOfDayIn(d), to: startOfDayIn(addCalendarDays(d, 1)) };
}

type Plan = {
  id: string;
  name: LocalizedText;
  interval: Interval;
  discountPct: string;
  inclusions: { kind: Exclude<CreditKind, "euro">; units: number }[];
};

/** The plan (a commerce product of kind `membership`) with its primary and extra inclusions (rule 44). */
export async function loadPlan(db: DbOrTx, productId: string): Promise<Plan> {
  if (!UUID_RE.test(productId)) throw new ValidationError("product_not_found", { productId: "not_found" });
  const [p] = await db.select().from(products).where(eq(products.id, productId));
  if (!p) throw new ValidationError("product_not_found", { productId: "not_found" });
  if (p.kind !== "membership" || !p.recurringInterval) throw new ValidationError("not_a_membership_plan", { productId: "not_membership" });
  const inclusions: Plan["inclusions"] = [];
  const primary = p.includedCreditKind;
  if (primary && primary !== "euro" && p.includedCreditUnits) inclusions.push({ kind: primary, units: p.includedCreditUnits });
  const extra = await db
    .select({ kind: membershipPlanInclusions.creditKind, units: membershipPlanInclusions.unitsPerPeriod })
    .from(membershipPlanInclusions)
    .where(and(eq(membershipPlanInclusions.productId, p.id), eq(membershipPlanInclusions.isActive, true)))
    .orderBy(asc(membershipPlanInclusions.creditKind));
  for (const e of extra) {
    if (e.kind === "euro" || inclusions.some((i) => i.kind === e.kind)) continue;
    inclusions.push({ kind: e.kind, units: e.units });
  }
  return { id: p.id, name: p.name, interval: p.recurringInterval, discountPct: p.memberDiscountPct ?? "0", inclusions };
}

/**
 * The anchor day of a membership's periods (edge case 13): the Brussels day of the start of its
 * latest period that set a new anchor (`purchase`, `late_payment` or `import`), or the end day of
 * a later staff extension (rule 55 moves the following periods), else `started_at`.
 */
async function anchorOf(db: DbOrTx, m: MembershipRow): Promise<number> {
  const [p] = await db
    .select({ start: membershipPeriods.periodStartAt, end: membershipPeriods.periodEndAt, source: membershipPeriods.source })
    .from(membershipPeriods)
    .where(and(eq(membershipPeriods.membershipId, m.id), inArray(membershipPeriods.source, ["purchase", "late_payment", "import", "staff_extension"])))
    .orderBy(desc(membershipPeriods.periodStartAt))
    .limit(1);
  if (!p) return anchorDayOf(m.startedAt);
  return anchorDayOf(p.source === "staff_extension" ? p.end : p.start);
}

async function orderAmount(db: DbOrTx, orderId: string | null): Promise<number> {
  if (!orderId) return 0;
  const [o] = await db.select({ total: orders.totalCents }).from(orders).where(eq(orders.id, orderId));
  return Number(o?.total ?? 0);
}

/** The plan's `public` price valid at `at` (the amount a renewal reminder shows, edge case 27). */
async function publicPriceCents(db: DbOrTx, productId: string, at: Date): Promise<number | null> {
  const [pv] = await db
    .select({ amount: priceVersions.amountCents })
    .from(priceVersions)
    .where(
      and(
        eq(priceVersions.productId, productId),
        eq(priceVersions.audience, "public"),
        lte(priceVersions.validFromAt, at),
        or(sql`${priceVersions.validToAt} is null`, sql`${priceVersions.validToAt} > ${at.toISOString()}::timestamptz`),
      ),
    )
    .orderBy(desc(priceVersions.validFromAt), desc(priceVersions.version))
    .limit(1);
  return pv ? Number(pv.amount) : null;
}

async function personLocale(db: DbOrTx, personId: string): Promise<Locale> {
  const [p] = await db.select({ locale: persons.locale }).from(persons).where(eq(persons.id, personId));
  return (p?.locale ?? "nl-BE");
}

/**
 * Sends one membership email (credits spec section 6 and 8): template `credits.<name>`, the
 * person's locale, ids and display values only, key `credits:<name>:<membership_id>:<qualifier>`.
 */
async function sendMembershipEmail(
  ctx: Ctx,
  m: MembershipRow,
  name: MembershipTemplate,
  qualifier: string,
  data: Record<string, unknown>,
): Promise<void> {
  const locale = await personLocale(ctx.tx, m.personId);
  const [p] = await ctx.tx.select({ name: products.name }).from(products).where(eq(products.id, m.productId));
  const planName = (p?.name)?.[locale] ?? "";
  await sendTransactional(ctx, {
    template: `credits.${name}`,
    personId: m.personId,
    locale,
    data: { membershipId: m.id, planName, accountUrl: appUrl(`/${locale}/account/membership`), ...data },
    key: `credits:${name}:${m.id}:${qualifier}`,
  });
}

/** Records a `membership.*` event on the member's timeline; `null` id = deduped (already recorded). */
async function membershipEvent(
  ctx: Ctx,
  m: MembershipRow,
  kind: Parameters<Ctx["recordEvent"]>[0]["kind"],
  dedupeKey: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const r = await ctx.recordEvent({ kind, personId: m.personId, ref: membershipRef(m.id), occurredAt: ctx.now, dedupeKey, data: { membership_id: m.id, ...data } });
  return r.id !== null;
}

/** `membership:<id>:<suffix>:<period_end date>` (credits spec section 4 events). */
const dedupe = (m: MembershipRow, suffix: string) => `membership:${m.id}:${suffix}:${dateKey(m.currentPeriodEndAt)}`;

// ---------------------------------------------------------------------------
// Inclusion grants (rule 46)
// ---------------------------------------------------------------------------

/**
 * Grants every inclusion of the plan for the period `[start, end)`: source `membership`,
 * `starts_at = start`, `expires_at = end` (no rollover), unit value 0, `not_applicable`, sharing
 * `none`, key `grant:membership:<id>:<period start date>:<kind>`. A second call writes nothing.
 */
export async function grantInclusions(tx: DbOrTx, ctx: Ctx, m: MembershipRow, start: Date, end: Date): Promise<string[]> {
  const plan = await loadPlan(tx, m.productId);
  const ids: string[] = [];
  for (const inc of plan.inclusions) {
    const key = `grant:membership:${m.id}:${dateKey(start)}:${inc.kind}`;
    const prior = await entryByKey(tx, key);
    if (prior) {
      ids.push(prior.grantId);
      continue;
    }
    const [g] = await tx
      .insert(creditGrants)
      .values({
        personId: m.personId,
        productId: m.productId,
        membershipId: m.id,
        creditKind: inc.kind,
        unitsGranted: inc.units,
        unitValueCents: 0,
        vatRatePct: null,
        vatTreatment: "not_applicable",
        startsAt: start,
        expiresAt: end,
        validityRule: "fixed",
        status: "active",
        statusChangedAt: ctx.now,
        source: "membership",
        sharing: { mode: "none", max_guest_uses_per_month: 0, allowed_person_ids: [] },
        data: {},
      })
      .returning();
    await writeEntry(tx, ctx, { grantId: g!.id, personId: m.personId, kind: "grant", quantity: inc.units, refType: "membership", refId: m.id, key });
    await ctx.recordEvent({
      kind: "credits.granted",
      personId: m.personId,
      ref: { type: "credit_grant", id: g!.id },
      occurredAt: ctx.now,
      dedupeKey: `grant:${g!.id}:granted`,
      data: { grant_id: g!.id, credit_kind: inc.kind, units: inc.units, source: "membership", product_id: m.productId },
    });
    ids.push(g!.id);
  }
  return ids;
}

/** The inclusion grants of the membership's current period. */
async function currentPeriodGrants(tx: DbOrTx, m: MembershipRow) {
  return tx
    .select()
    .from(creditGrants)
    .where(and(eq(creditGrants.membershipId, m.id), eq(creditGrants.source, "membership"), eq(creditGrants.startsAt, m.currentPeriodStartAt)))
    .orderBy(asc(creditGrants.id));
}

// ---------------------------------------------------------------------------
// Start (rules 45 to 47, 57)
// ---------------------------------------------------------------------------

/**
 * Whether `personId` may start a membership (rule 47): refused with `already_member` while an
 * `active` or `past_due` membership exists, unless it ends at period end (`cancel_at`) and the
 * new plan starts on that date (plan change, rule 57); refused with `pending_exists` while a
 * `pending` one exists.
 */
export async function canStartMembership(
  db: DbOrTx,
  personId: string,
  opts: { startsOn?: string } = {},
): Promise<{ ok: true } | { ok: false; reason: "already_member" | "pending_exists" }> {
  if (!UUID_RE.test(personId)) return { ok: true };
  const rows = await db
    .select({ status: memberships.status, cancelAt: memberships.cancelAt })
    .from(memberships)
    .where(and(eq(memberships.personId, personId), inArray(memberships.status, ["pending", "active", "past_due"])));
  const live = rows.find((r) => r.status === "active" || r.status === "past_due");
  if (live) {
    const planChange = live.status === "active" && live.cancelAt !== null && opts.startsOn !== undefined && opts.startsOn === dateKey(live.cancelAt);
    if (!planChange) return { ok: false, reason: "already_member" };
  }
  if (rows.some((r) => r.status === "pending")) return { ok: false, reason: "pending_exists" };
  return { ok: true };
}

/** The next automatic charge of a period (T - `renewal_charge_lead_days`) when a mandate exists. */
function chargeAtFor(periodEnd: Date, mandateId: string | null, s: CreditsSettings): Date | null {
  return mandateId ? renewalLeadDates(periodEnd, { chargeLeadDays: s.renewal_charge_lead_days, linkLeadDays: s.renewal_link_lead_days }).chargeAt : null;
}

/** Grants the period's inclusions and announces a membership that is now `active` (rule 45). */
async function announceActive(tx: DbOrTx, ctx: Ctx, m: MembershipRow): Promise<void> {
  await grantInclusions(tx, ctx, m, m.currentPeriodStartAt, m.currentPeriodEndAt);
  await membershipEvent(ctx, m, "membership.started", dedupe(m, "started"), { product_id: m.productId, status: "active" });
}

/**
 * The paid membership line of commerce's paid transaction (rule 45). Creates the membership
 * `active` (or `pending` for a future `startsAt`) with its first period (`start + 1 interval`,
 * anchor clamped, Brussels), the plan's discount snapshot, the mandate, a `membership_periods`
 * row, the inclusion grants (when active), `membership.started` and the email
 * `credits.membership_started`. Idempotent per `orderId`. Refuses (`conflict`) when rule 47
 * would be broken (`already_member`, `pending_exists`).
 */
export async function activateMembership(
  tx: DbOrTx,
  ctx: Ctx,
  input: { personId: string; productId: string; orderId: string; priceVersionId: string; mandateId: string | null; startsAt: Date },
): Promise<{ membershipId: string; status: "active" | "pending"; created: boolean }> {
  if (!UUID_RE.test(input.personId)) throw new ValidationError("person_not_found", { personId: "uuid" });
  if (!UUID_RE.test(input.orderId)) throw new ValidationError("order_not_found", { orderId: "uuid" });
  if (Number.isNaN(input.startsAt.getTime())) throw new ValidationError("invalid_start", { startsAt: "date" });
  await lockKey(tx, `membership:person:${input.personId}`);
  const [existing] = await tx.select().from(memberships).where(eq(memberships.firstOrderId, input.orderId)).limit(1);
  if (existing) return { membershipId: existing.id, status: existing.status === "pending" ? "pending" : "active", created: false };

  const plan = await loadPlan(tx, input.productId);
  const can = await canStartMembership(tx, input.personId, { startsOn: dateKey(input.startsAt) });
  if (!can.ok) throw new ConflictError(can.reason);
  const settings = await creditsSettings(tx);
  const status: "active" | "pending" = input.startsAt.getTime() <= ctx.now.getTime() ? "active" : "pending";
  assertMembershipTransition("new", status);
  if (status === "active") {
    // A plan change paid on the old plan's last day (rule 57): `canStartMembership` has checked
    // that the live row ends at period end on `startsOn` (today or earlier), so it ends now, as
    // `activatePending` does on the change day, before the new row takes the live slot.
    const [live] = await tx
      .select()
      .from(memberships)
      .where(and(eq(memberships.personId, input.personId), inArray(memberships.status, LIVE)))
      .for("update");
    if (live) await endAtCancel(tx, ctx, live);
  }
  const period = nextPeriod(input.startsAt, plan.interval, anchorDayOf(input.startsAt));
  const [m] = await tx
    .insert(memberships)
    .values({
      personId: input.personId,
      productId: plan.id,
      status,
      interval: plan.interval,
      source: "purchase",
      startedAt: input.startsAt,
      currentPeriodStartAt: period.start,
      currentPeriodEndAt: period.end,
      mandateId: input.mandateId,
      priceVersionId: input.priceVersionId,
      firstOrderId: input.orderId,
      discountPct: plan.discountPct,
      nextChargeAt: chargeAtFor(period.end, input.mandateId, settings),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  const row = m!;
  await tx.insert(membershipPeriods).values({
    membershipId: row.id,
    personId: row.personId,
    periodStartAt: period.start,
    periodEndAt: period.end,
    source: "purchase",
    orderId: input.orderId,
    amountCents: await orderAmount(tx, input.orderId),
    createdAt: ctx.now,
  });
  if (status === "active") await announceActive(tx, ctx, row);
  else await membershipEvent(ctx, row, "membership.started", dedupe(row, "started_pending"), { product_id: row.productId, status: "pending" });
  await sendMembershipEmail(ctx, row, "membership_started", "start", {
    status,
    startsOn: dateKey(period.start),
    periodEndOn: dateKey(period.end),
  });
  return { membershipId: row.id, status, created: true };
}

/**
 * Activates a due `pending` membership (scan, rule 45). A plan change (rule 57) starts on the
 * day the old plan ends; the old membership is ended first when its `cancel_at` falls on or
 * before today's Brussels day, otherwise activation waits for the next scan.
 */
async function activatePending(tx: DbOrTx, ctx: Ctx, m: MembershipRow): Promise<"activated" | "waiting"> {
  const [live] = await tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.personId, m.personId), inArray(memberships.status, LIVE)))
    .for("update");
  if (live) {
    const endsToday = live.cancelAt !== null && dateKey(live.cancelAt) <= dateKey(ctx.now);
    if (!endsToday) return "waiting";
    await endAtCancel(tx, ctx, live);
  }
  const row = await transition(tx, ctx, m, "active");
  await announceActive(tx, ctx, row);
  return "activated";
}

// ---------------------------------------------------------------------------
// Reads (rules 44, 59; site account home)
// ---------------------------------------------------------------------------

/** The live membership that drives member pricing and member-only access (rule 59). */
export async function getMembershipForPerson(
  db: DbOrTx,
  personId: string,
): Promise<{
  isMember: boolean;
  membershipId: string | null;
  planProductId: string | null;
  discountPct: number;
  status: "active" | "past_due" | null;
  periodEndAt: Date | null;
  cancelAt: Date | null;
}> {
  const none = { isMember: false, membershipId: null, planProductId: null, discountPct: 0, status: null, periodEndAt: null, cancelAt: null };
  if (!UUID_RE.test(personId)) return none;
  const [m] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.personId, personId), inArray(memberships.status, LIVE)))
    .orderBy(desc(memberships.startedAt))
    .limit(1);
  if (!m) return none;
  return {
    isMember: true,
    membershipId: m.id,
    planProductId: m.productId,
    discountPct: Number(m.discountPct),
    status: m.status as "active" | "past_due",
    periodEndAt: m.currentPeriodEndAt,
    cancelAt: m.cancelAt,
  };
}

/** The membership card of the portal home (site): the live membership, else the `pending` one. */
export async function getMembershipSummary(
  db: DbOrTx,
  personId: string,
): Promise<{ status: string; productName: LocalizedText; currentPeriodEndAt: Date; includedCredits: { kind: CreditKind; remainingUnits: number }[] } | null> {
  if (!UUID_RE.test(personId)) return null;
  const rows = await db
    .select({ m: memberships, name: products.name })
    .from(memberships)
    .innerJoin(products, eq(products.id, memberships.productId))
    .where(and(eq(memberships.personId, personId), inArray(memberships.status, ["active", "past_due", "pending"])));
  const pick = rows.find((r) => r.m.status !== "pending") ?? rows[0];
  if (!pick) return null;
  const balances = await db
    .select({ kind: vCreditGrantBalances.creditKind, remaining: vCreditGrantBalances.remainingUnits })
    .from(vCreditGrantBalances)
    .innerJoin(creditGrants, eq(creditGrants.id, vCreditGrantBalances.grantId))
    .where(and(eq(creditGrants.membershipId, pick.m.id), eq(creditGrants.startsAt, pick.m.currentPeriodStartAt)))
    .orderBy(asc(vCreditGrantBalances.creditKind));
  return {
    status: pick.m.status,
    productName: pick.name,
    currentPeriodEndAt: pick.m.currentPeriodEndAt,
    includedCredits: balances.map((b) => ({ kind: b.kind, remainingUnits: Number(b.remaining) })),
  };
}

// ---------------------------------------------------------------------------
// Import (ops import kind `memberships`)
// ---------------------------------------------------------------------------

/**
 * An imported membership: the period is `periodEndAt - 1 interval` to `periodEndAt`; ended rows
 * (`cancelled`, `expired`) get `end_reason = not_renewed`. Inclusion grants only for an `active`
 * row whose period is running now (no grants for past periods). A re-run with the same input
 * (same person, plan and start, source `import`) returns the existing row.
 */
export async function importMembership(
  tx: DbOrTx,
  ctx: Ctx,
  input: {
    personId: string;
    productId: string;
    periodEndAt: Date;
    idempotencyKey: string;
    startedAt?: Date;
    status?: "active" | "cancelled" | "expired";
    mandateId?: string | null;
  },
): Promise<{ membershipId: string; created: boolean }> {
  if (!input.idempotencyKey.trim()) throw new ValidationError("missing_key", { idempotencyKey: "required" });
  await lockKey(tx, `membership:import:${input.idempotencyKey}`);
  await lockKey(tx, `membership:person:${input.personId}`);
  const plan = await loadPlan(tx, input.productId);
  const periodStart = periodStartBefore(input.periodEndAt, plan.interval);
  const startedAt = input.startedAt ?? periodStart;
  const [existing] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.personId, input.personId), eq(memberships.productId, plan.id), eq(memberships.source, "import"), eq(memberships.startedAt, startedAt)))
    .limit(1);
  if (existing) return { membershipId: existing.id, created: false };
  const status = input.status ?? "active";
  assertMembershipTransition("imported", status, { endReason: status === "active" ? null : "not_renewed" });
  if (status === "active") {
    const can = await canStartMembership(tx, input.personId);
    if (!can.ok) throw new ConflictError(can.reason);
  }
  const settings = await creditsSettings(tx);
  const ended = status !== "active";
  const endedAt = ended ? new Date(Math.min(input.periodEndAt.getTime(), ctx.now.getTime())) : null;
  const [m] = await tx
    .insert(memberships)
    .values({
      personId: input.personId,
      productId: plan.id,
      status,
      interval: plan.interval,
      source: "import",
      startedAt,
      currentPeriodStartAt: periodStart,
      currentPeriodEndAt: input.periodEndAt,
      endedAt,
      endReason: ended ? "not_renewed" : null,
      mandateId: input.mandateId ?? null,
      discountPct: plan.discountPct,
      nextChargeAt: ended ? null : chargeAtFor(input.periodEndAt, input.mandateId ?? null, settings),
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  const row = m!;
  await tx.insert(membershipPeriods).values({
    membershipId: row.id,
    personId: row.personId,
    periodStartAt: periodStart,
    periodEndAt: input.periodEndAt,
    source: "import",
    createdAt: ctx.now,
  });
  const running = periodStart.getTime() <= ctx.now.getTime() && input.periodEndAt.getTime() > ctx.now.getTime();
  if (status === "active" && running) await grantInclusions(tx, ctx, row, periodStart, input.periodEndAt);
  return { membershipId: row.id, created: true };
}

// ---------------------------------------------------------------------------
// Renewal payment (rule 49, edge cases 8 and 9)
// ---------------------------------------------------------------------------

/**
 * Moves a locked membership into the period starting at `start` (renewal: the old end; late
 * payment: `paid_at`), writes the `membership_periods` row (unique per start, so a replay writes
 * nothing), clears dunning, grants the inclusions, records `membership.renewed` and emails
 * `credits.membership_renewed`.
 */
export async function renewMembership(
  tx: DbOrTx,
  ctx: Ctx,
  m: MembershipRow,
  input: { orderId: string; start: Date; source: "renewal" | "late_payment" },
): Promise<{ periodStartAt: Date; periodEndAt: Date; applied: boolean; membership: MembershipRow }> {
  const anchor = input.source === "late_payment" ? anchorDayOf(input.start) : await anchorOf(tx, m);
  const period = nextPeriod(input.start, m.interval, anchor);
  const [p] = await tx
    .insert(membershipPeriods)
    .values({
      membershipId: m.id,
      personId: m.personId,
      periodStartAt: period.start,
      periodEndAt: period.end,
      source: input.source,
      orderId: input.orderId,
      amountCents: await orderAmount(tx, input.orderId),
      createdAt: ctx.now,
    })
    .onConflictDoNothing()
    .returning({ id: membershipPeriods.id });
  if (!p) return { periodStartAt: m.currentPeriodStartAt, periodEndAt: m.currentPeriodEndAt, applied: false, membership: m };
  const [line] = await tx
    .select({ priceVersionId: orderLines.priceVersionId })
    .from(orderLines)
    .where(and(eq(orderLines.orderId, input.orderId), eq(orderLines.productId, m.productId)))
    .limit(1);
  const settings = await creditsSettings(tx);
  const patch = {
    currentPeriodStartAt: period.start,
    currentPeriodEndAt: period.end,
    dunningAttempt: 0,
    pastDueSinceAt: null,
    renewalOrderId: null,
    priceVersionId: line?.priceVersionId ?? m.priceVersionId,
    nextChargeAt: chargeAtFor(period.end, m.mandateId, settings),
  };
  const row = m.status === "active" ? await update(tx, ctx, m, patch) : await transition(tx, ctx, m, "active", patch);
  await grantInclusions(tx, ctx, row, period.start, period.end);
  const late = input.source === "late_payment";
  await membershipEvent(ctx, row, "membership.renewed", dedupe(row, "renewed"), { late });
  await sendMembershipEmail(ctx, row, "membership_renewed", dateKey(period.start), {
    late,
    periodStartOn: dateKey(period.start),
    periodEndOn: dateKey(period.end),
  });
  return { periodStartAt: period.start, periodEndAt: period.end, applied: true, membership: row };
}

/**
 * Commerce's paid transaction for the order in `renewal_order_id` (rule 49). A replay, an order
 * that is not the open renewal order, or a membership that ended otherwise returns
 * `applied: false`. An `expired` membership (`payment_failed`, `not_renewed`) whose cancelled
 * renewal order is paid late is reactivated from `paid_at` (source `late_payment`, edge case 9)
 * with a crm review task, unless the person holds another membership by then.
 */
export async function applyRenewalPayment(
  tx: DbOrTx,
  ctx: Ctx,
  input: { membershipId: string; orderId: string },
): Promise<{ periodStartAt: Date; periodEndAt: Date; applied: boolean }> {
  const m = await lockMembership(tx, input.membershipId);
  const unchanged = { periodStartAt: m.currentPeriodStartAt, periodEndAt: m.currentPeriodEndAt, applied: false };
  if (m.renewalOrderId !== input.orderId) return unchanged;
  if (m.status === "active" || m.status === "past_due") {
    const r = await renewMembership(tx, ctx, m, { orderId: input.orderId, start: m.currentPeriodEndAt, source: "renewal" });
    return { periodStartAt: r.periodStartAt, periodEndAt: r.periodEndAt, applied: r.applied };
  }
  if (m.status !== "expired" || (m.endReason !== "payment_failed" && m.endReason !== "not_renewed")) return unchanged;
  const [other] = await tx
    .select({ id: memberships.id })
    .from(memberships)
    .where(and(eq(memberships.personId, m.personId), inArray(memberships.status, ["pending", "active", "past_due"])))
    .limit(1);
  if (other) return unchanged;
  const [o] = await tx.select({ paidAt: orders.paidAt }).from(orders).where(eq(orders.id, input.orderId));
  const r = await renewMembership(tx, ctx, m, { orderId: input.orderId, start: o?.paidAt ?? ctx.now, source: "late_payment" });
  if (r.applied) {
    await createTask(tx as Tx, ctx, {
      title: "Late membership payment: confirm the reactivated membership",
      kind: "review",
      ownerRole: "customer_service",
      personId: m.personId,
      dueAt: new Date(ctx.now.getTime() + 86_400_000),
      source: "system",
      ref: membershipRef(m.id),
      dedupeKey: `membership:${m.id}:late_payment:${input.orderId}`,
    });
  }
  return { periodStartAt: r.periodStartAt, periodEndAt: r.periodEndAt, applied: r.applied };
}

// ---------------------------------------------------------------------------
// Dunning (rules 50, 50a, 52)
// ---------------------------------------------------------------------------

const dunningSettings = (s: CreditsSettings) => ({ retryDays: [...s.dunning_retry_days], expireDay: s.dunning_expire_day });

/** Link path (rule 52): `past_due` from the period end, so `past_due_since_at = current_period_end_at`. */
const isLinkPath = (m: MembershipRow) => m.pastDueSinceAt !== null && m.pastDueSinceAt.getTime() === m.currentPeriodEndAt.getTime();

/** `credits.membership_payment_failed` with the BEAM pay link of the open renewal order (day 0, 3, 7). */
async function paymentFailedEmail(tx: DbOrTx, ctx: Ctx, m: MembershipRow, attempt: number, s: CreditsSettings): Promise<void> {
  if (!m.renewalOrderId) return;
  const { payUrl } = await getPayLinkForOrder(tx as Tx, ctx, { orderId: m.renewalOrderId });
  const since = m.pastDueSinceAt ?? ctx.now;
  await sendMembershipEmail(ctx, m, "membership_payment_failed", `${dateKey(m.currentPeriodEndAt)}:${attempt}`, {
    attempt,
    payUrl,
    expiresOn: dateKey(dunningSchedule(since, dunningSettings(s)).expireAt),
  });
}

/** Was a failure for this payment already applied? (A repeated `applyRenewalFailure` changes nothing.) */
async function failureSeen(db: DbOrTx, membershipId: string, paymentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: activityEvents.id })
    .from(activityEvents)
    .where(
      and(
        eq(activityEvents.refType, "membership"),
        eq(activityEvents.refId, membershipId),
        inArray(activityEvents.kind, ["membership.past_due", "membership.payment_retry_failed"]),
        sql`${activityEvents.data}->>'payment_id' = ${paymentId}`,
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Rule 50a: counts today's (Brussels) `membership.past_due` and `membership.payment_retry_failed`
 * events; exactly at `failed_renewals_alert_per_day` it calls `notifySlack` once
 * (fingerprint `renewals_failed:<YYYY-MM-DD>`).
 */
export async function alertFailedRenewals(tx: DbOrTx, ctx: Ctx): Promise<{ count: number; alerted: boolean }> {
  const settings = await creditsSettings(tx);
  const day = brusselsDayWindow(ctx.now);
  const [r] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(activityEvents)
    .where(
      and(
        inArray(activityEvents.kind, ["membership.past_due", "membership.payment_retry_failed"]),
        gte(activityEvents.occurredAt, day.from),
        lt(activityEvents.occurredAt, day.to),
      ),
    );
  const count = Number(r?.n ?? 0);
  if (count !== settings.failed_renewals_alert_per_day) return { count, alerted: false };
  await notifySlack(ctx, {
    fingerprint: `renewals_failed:${dateKey(ctx.now)}`,
    severity: "high",
    text: `${count} membership renewals failed today. Review: ${appUrl("/admin/memberships?status=past_due")}`,
  });
  return { count, alerted: true };
}

/**
 * A failed renewal payment (rule 50). The first failure makes the membership `past_due`
 * (`dunning_attempt = 1`, `past_due_since_at = now`, next charge on day 3); a retry failure
 * raises `dunning_attempt` (next charge on day 7, then none). Each records its event, sends
 * `credits.membership_payment_failed` with the pay link and runs the daily alert check. The same
 * `paymentId` twice, a membership without an open renewal order (already paid) or one that ended
 * changes nothing (`applied: false`; `status` is then `expired` for an ended membership, else
 * `past_due`).
 */
export async function applyRenewalFailure(
  tx: DbOrTx,
  ctx: Ctx,
  input: { membershipId: string; paymentId: string; reason: string },
): Promise<{ status: "past_due" | "expired"; dunningAttempt: number; applied: boolean }> {
  const m = await lockMembership(tx, input.membershipId);
  const live = m.status === "active" || m.status === "past_due";
  const reported: "past_due" | "expired" = live ? "past_due" : "expired";
  const unchanged = { status: reported, dunningAttempt: m.dunningAttempt, applied: false };
  if (!live || m.renewalOrderId === null) return unchanged;
  if (await failureSeen(tx, m.id, input.paymentId)) return unchanged;
  const s = await creditsSettings(tx);
  let row: MembershipRow;
  if (m.status === "active") {
    const sched = dunningSchedule(ctx.now, dunningSettings(s));
    row = await transition(tx, ctx, m, "past_due", { dunningAttempt: 1, pastDueSinceAt: ctx.now, nextChargeAt: sched.retry2At });
    await membershipEvent(ctx, row, "membership.past_due", dedupe(row, "past_due"), { dunning_attempt: 1, payment_id: input.paymentId, via: "mandate" });
  } else {
    if (m.dunningAttempt >= 3) return unchanged;
    const attempt = m.dunningAttempt + 1;
    const sched = dunningSchedule(m.pastDueSinceAt ?? ctx.now, dunningSettings(s));
    row = await update(tx, ctx, m, { dunningAttempt: attempt, nextChargeAt: attempt === 2 ? sched.retry3At : null });
    await membershipEvent(ctx, row, "membership.payment_retry_failed", dedupe(row, `payment_retry_failed:${attempt}`), { attempt, payment_id: input.paymentId });
  }
  await paymentFailedEmail(tx, ctx, row, row.dunningAttempt, s);
  await alertFailedRenewals(tx, ctx);
  return { status: "past_due", dunningAttempt: row.dunningAttempt, applied: true };
}

/** Link path unpaid at period end (rule 52): `past_due` from `current_period_end_at`. */
export async function markPastDue(tx: DbOrTx, ctx: Ctx, m: MembershipRow): Promise<MembershipRow> {
  const s = await creditsSettings(tx);
  const row = await transition(tx, ctx, m, "past_due", { dunningAttempt: 1, pastDueSinceAt: m.currentPeriodEndAt, nextChargeAt: null });
  await membershipEvent(ctx, row, "membership.past_due", dedupe(row, "past_due"), { dunning_attempt: 1, payment_id: null, via: "link" });
  await paymentFailedEmail(tx, ctx, row, 1, s);
  return row;
}

/**
 * Day 10 after the first failure (rule 50) or after the period end (link path, rule 52):
 * `expired` with `payment_failed` or `not_renewed`, the renewal order cancelled through commerce
 * (its id stays in `renewal_order_id`, so a late payment can still reactivate, edge case 9),
 * `membership.expired`, `credits.membership_expired` and audit `memberships.ended`.
 */
export async function expireMembership(tx: DbOrTx, ctx: Ctx, m: MembershipRow): Promise<MembershipRow> {
  const reason: MembershipEndReason = isLinkPath(m) ? "not_renewed" : "payment_failed";
  if (m.renewalOrderId) await cancelRenewalOrder(tx as Tx, ctx, { orderId: m.renewalOrderId, reason: "membership_expired" });
  const row = await transition(tx, ctx, m, "expired", {}, reason);
  await membershipEvent(ctx, row, "membership.expired", dedupe(row, "expired"), { end_reason: reason });
  await sendMembershipEmail(ctx, row, "membership_expired", dateKey(row.currentPeriodEndAt), { endedOn: dateKey(ctx.now) });
  await ctx.audit({
    action: "memberships.ended",
    entityType: "membership",
    entityId: row.id,
    personId: row.personId,
    oldValue: { status: m.status },
    newValue: { status: "expired", end_reason: reason },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Cancel, resume, refund, period extension (rules 27a, 53 to 55)
// ---------------------------------------------------------------------------

/** Who asked for the cancel at period end (from the latest `membership.cancel_requested`). */
async function cancelRequester(db: DbOrTx, m: MembershipRow): Promise<Requester> {
  const [e] = await db
    .select({ data: activityEvents.data })
    .from(activityEvents)
    .where(and(eq(activityEvents.refType, "membership"), eq(activityEvents.refId, m.id), eq(activityEvents.kind, "membership.cancel_requested")))
    .orderBy(desc(activityEvents.occurredAt), desc(activityEvents.id))
    .limit(1);
  return (e?.data as { requested_by?: Requester } | undefined)?.requested_by === "staff" ? "staff" : "customer";
}

/** The scan at `cancel_at` (rule 53): `cancelled` with the requester's end reason, audit `memberships.ended`. */
async function endAtCancel(tx: DbOrTx, ctx: Ctx, m: MembershipRow): Promise<MembershipRow> {
  const by = await cancelRequester(tx, m);
  const reason: MembershipEndReason = by === "staff" ? "cancelled_by_staff" : "cancelled_by_customer";
  const row = await transition(tx, ctx, m, "cancelled", {}, reason);
  await membershipEvent(ctx, row, "membership.cancelled", dedupe(row, "cancelled"), { end_reason: reason });
  await ctx.audit({
    action: "memberships.ended",
    entityType: "membership",
    entityId: row.id,
    personId: row.personId,
    oldValue: { status: m.status, cancel_at: m.cancelAt?.toISOString() ?? null },
    newValue: { status: "cancelled", end_reason: reason },
  });
  return row;
}

function checkReason(reason: string | undefined, required: boolean): string | null {
  const r = (reason ?? "").trim();
  if (!r && !required) return null;
  if (r.length < 3 || r.length > 500) throw new ValidationError("invalid_reason", { reason: "3 to 500 characters" });
  return r;
}

/**
 * Immediate cancel (rule 53 for `pending` and a customer's `past_due`, rule 54 staff mode
 * `now`): `cancelled` with `cancelled_by_customer` or `cancelled_by_staff`, the open renewal
 * order cancelled, `membership.cancelled`, audit `memberships.cancelled_now`, email
 * `credits.membership_cancel_confirmed`. Included grants of the current period stay usable.
 */
export async function cancelNow(
  tx: DbOrTx,
  ctx: Ctx,
  input: { membershipId: string; by: Requester; reason?: string; version?: number },
): Promise<MembershipRow> {
  const reasonText = checkReason(input.reason, input.by === "staff");
  const m = await lockMembership(tx, input.membershipId);
  checkVersion(m, input.version);
  if (m.status !== "pending" && m.status !== "active" && m.status !== "past_due") throw new ConflictError(`membership_${m.status}`);
  const endReason: MembershipEndReason = input.by === "staff" ? "cancelled_by_staff" : "cancelled_by_customer";
  if (m.renewalOrderId) await cancelRenewalOrder(tx as Tx, ctx, { orderId: m.renewalOrderId, reason: "membership_cancelled" });
  const row = await transition(tx, ctx, m, "cancelled", { renewalOrderId: null }, endReason);
  await membershipEvent(ctx, row, "membership.cancelled", dedupe(row, "cancelled"), { end_reason: endReason });
  await ctx.audit({
    action: "memberships.cancelled_now",
    entityType: "membership",
    entityId: row.id,
    personId: row.personId,
    oldValue: { status: m.status },
    newValue: { status: "cancelled", end_reason: endReason, reason: reasonText },
  });
  await sendMembershipEmail(ctx, row, "membership_cancel_confirmed", "now", { immediate: true, endsOn: dateKey(ctx.now) });
  return row;
}

/**
 * Cancel at period end (rule 53): `cancel_at = current_period_end_at`, no further charges, the
 * open renewal order cancelled, `membership.cancel_requested`, audit `memberships.cancel_requested`
 * and `credits.membership_cancel_confirmed`. A `pending` membership, and a `past_due` one cancelled
 * by the customer, end at once (`cancelNow`); staff cancel a `past_due` one only with mode `now`.
 */
export async function requestCancel(
  tx: DbOrTx,
  ctx: Ctx,
  input: { membershipId: string; by: Requester; reason?: string; version?: number },
): Promise<{ mode: "period_end" | "now"; membership: MembershipRow }> {
  const m = await lockMembership(tx, input.membershipId);
  checkVersion(m, input.version);
  if (m.status === "pending" || (m.status === "past_due" && input.by === "customer")) {
    return { mode: "now", membership: await cancelNow(tx, ctx, { ...input, version: undefined }) };
  }
  if (m.status !== "active") throw new ConflictError(m.status === "past_due" ? "past_due_cancel_now_only" : `membership_${m.status}`);
  if (m.cancelAt) return { mode: "period_end", membership: m };
  if (m.renewalOrderId) await cancelRenewalOrder(tx as Tx, ctx, { orderId: m.renewalOrderId, reason: "membership_cancelled" });
  const row = await update(tx, ctx, m, { cancelAt: m.currentPeriodEndAt, cancelRequestedAt: ctx.now, nextChargeAt: null, renewalOrderId: null });
  await membershipEvent(ctx, row, "membership.cancel_requested", dedupe(row, `cancel_requested:v${row.version}`), {
    cancel_at: m.currentPeriodEndAt.toISOString(),
    requested_by: input.by,
  });
  await ctx.audit({
    action: "memberships.cancel_requested",
    entityType: "membership",
    entityId: row.id,
    personId: row.personId,
    oldValue: { cancel_at: null },
    newValue: { cancel_at: m.currentPeriodEndAt.toISOString(), reason: checkReason(input.reason, false) },
  });
  await sendMembershipEmail(ctx, row, "membership_cancel_confirmed", `${dateKey(row.currentPeriodEndAt)}:v${row.version}`, {
    immediate: false,
    endsOn: dateKey(row.currentPeriodEndAt),
  });
  return { mode: "period_end", membership: row };
}

/** Resume before `cancel_at` (rule 53): clears `cancel_at` and `cancel_requested_at`; `membership.resumed`, audit `memberships.resumed`. */
export async function resume(tx: DbOrTx, ctx: Ctx, input: { membershipId: string; version?: number }): Promise<MembershipRow> {
  const m = await lockMembership(tx, input.membershipId);
  checkVersion(m, input.version);
  if (m.status !== "active" || !m.cancelAt || m.cancelAt.getTime() <= ctx.now.getTime()) throw new ConflictError("not_cancelling");
  const s = await creditsSettings(tx);
  const row = await update(tx, ctx, m, { cancelAt: null, cancelRequestedAt: null, nextChargeAt: chargeAtFor(m.currentPeriodEndAt, m.mandateId, s) });
  await membershipEvent(ctx, row, "membership.resumed", dedupe(row, `resumed:v${row.version}`), {});
  await ctx.audit({
    action: "memberships.resumed",
    entityType: "membership",
    entityId: row.id,
    personId: row.personId,
    oldValue: { cancel_at: m.cancelAt.toISOString() },
    newValue: { cancel_at: null },
  });
  return row;
}

/**
 * Commerce's membership refund (rule 27a): cancels at once with `end_reason = refunded` (also
 * from `pending`), revokes the unused units of the current period's `active` inclusion grants
 * (key `revoke:membership_refund:<membership_id>:<grant_id>`); exhausted current-period grants and
 * earlier periods' grants are untouched. `membership.cancelled`, audit `memberships.cancelled_now`.
 * A replay changes nothing.
 */
export async function cancelMembershipForRefund(tx: DbOrTx, ctx: Ctx, input: { membershipId: string; reason: string }): Promise<void> {
  const m = await lockMembership(tx, input.membershipId);
  const reason = input.reason.trim() || "refund";
  let row = m;
  if (m.status === "pending" || m.status === "active" || m.status === "past_due") {
    if (m.renewalOrderId) await cancelRenewalOrder(tx as Tx, ctx, { orderId: m.renewalOrderId, reason: "membership_refunded" });
    row = await transition(tx, ctx, m, "cancelled", { renewalOrderId: null }, "refunded");
    await membershipEvent(ctx, row, "membership.cancelled", dedupe(row, "cancelled"), { end_reason: "refunded" });
    await ctx.audit({
      action: "memberships.cancelled_now",
      entityType: "membership",
      entityId: row.id,
      personId: row.personId,
      oldValue: { status: m.status },
      newValue: { status: "cancelled", end_reason: "refunded", reason },
    });
  }
  if (m.status === "pending") return;
  const current = (await currentPeriodGrants(tx, row)).filter((g) => g.status === "active");
  for (const grant of await lockGrants(tx, current.map((g) => g.id))) {
    if (grant.status !== "active") continue;
    const key = `revoke:membership_refund:${m.id}:${grant.id}`;
    if (await entryByKey(tx, key)) continue;
    const balance = await balanceOf(tx, grant.id);
    if (balance <= 0) continue;
    await writeEntry(tx, ctx, { grantId: grant.id, personId: grant.personId, kind: "revoke", quantity: -balance, reason, refType: "membership", refId: m.id, key });
    await setGrantStatus(tx, ctx, grant, "revoked");
    await ctx.recordEvent({
      kind: "credits.revoked",
      personId: grant.personId,
      ref: { type: "credit_grant", id: grant.id },
      occurredAt: ctx.now,
      dedupeKey: `grant:${grant.id}:revoked`,
      data: { grant_id: grant.id, credit_kind: grant.creditKind, units: balance },
    });
  }
}

/**
 * Staff period extension, the V1 pause (rule 55): moves `current_period_end_at`, `next_charge_at`
 * and `cancel_at` by `days` (1 to 90), writes `membership_periods` (source `staff_extension`),
 * `membership.period_extended` and audit `memberships.period_extended`; with
 * `alsoExtendInclusions` one `extend` per current inclusion grant (key `extend:<client_key>:<grant_id>`).
 * No extra inclusions. A replay with the same `clientKey` changes nothing.
 */
export async function extendPeriod(
  tx: DbOrTx,
  ctx: Ctx,
  input: { membershipId: string; days: number; reason: string; alsoExtendInclusions: boolean; clientKey: string; version?: number },
): Promise<{ created: boolean; periodEndAt: Date }> {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 90) throw new ValidationError("invalid_days", { days: "1 to 90" });
  const reason = checkReason(input.reason, true)!;
  const m = await lockMembership(tx, input.membershipId);
  const eventKey = `membership:${m.id}:period_extended:${input.clientKey}`;
  const [seen] = await tx.select({ id: activityEvents.id }).from(activityEvents).where(eq(activityEvents.dedupeKey, eventKey)).limit(1);
  if (seen) return { created: false, periodEndAt: m.currentPeriodEndAt };
  checkVersion(m, input.version);
  if (m.status !== "active" && m.status !== "past_due") throw new ConflictError(`membership_${m.status}`);
  const oldEnd = m.currentPeriodEndAt;
  const newEnd = shiftDays(oldEnd, input.days);
  await tx.insert(membershipPeriods).values({
    membershipId: m.id,
    personId: m.personId,
    periodStartAt: oldEnd,
    periodEndAt: newEnd,
    source: "staff_extension",
    createdByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null,
    createdAt: ctx.now,
  });
  const row = await update(tx, ctx, m, {
    currentPeriodEndAt: newEnd,
    nextChargeAt: m.nextChargeAt ? shiftDays(m.nextChargeAt, input.days) : null,
    cancelAt: m.cancelAt ? newEnd : null,
  });
  if (input.alsoExtendInclusions) {
    for (const g of await currentPeriodGrants(tx, m)) {
      if ((g.status !== "active" && g.status !== "exhausted") || !g.expiresAt) continue;
      await extend(tx, ctx, { grantId: g.id, newExpiresAt: shiftDays(g.expiresAt, input.days), reason, clientKey: `${input.clientKey}:${g.id}` });
    }
  }
  await membershipEvent(ctx, row, "membership.period_extended", eventKey, { days: input.days, period_end_on: dateKey(newEnd) });
  await ctx.audit({
    action: "memberships.period_extended",
    entityType: "membership",
    entityId: row.id,
    personId: row.personId,
    oldValue: { current_period_end_at: oldEnd.toISOString() },
    newValue: { current_period_end_at: newEnd.toISOString(), days: input.days, reason, also_extend_inclusions: input.alsoExtendInclusions },
  });
  return { created: true, periodEndAt: newEnd };
}

// ---------------------------------------------------------------------------
// The daily scan and the charge job (rules 45, 48, 50, 52, 53, 56)
// ---------------------------------------------------------------------------

/** `renewal:<membership_id>:<period_end date>` (attempt 1, architecture; the scan adds `:v<version>`) and `...:attempt:<n>` for retries. */
export function renewalJobKey(membershipId: string, periodEndOn: string, attempt: number): string {
  return attempt === 1 ? `renewal:${membershipId}:${periodEndOn}` : `renewal:${membershipId}:${periodEndOn}:attempt:${attempt}`;
}

/**
 * Enqueues `memberships.charge_renewal`. The scan's attempt 1 carries the membership `version`
 * (`renewal:<id>:<period_end>:v<version>`): scans of an unchanged row hit the same job, while a
 * row whose earlier job was used up (cancel then resume, a `no_mandate` run: each bumps
 * `version`) gets a new one. `chargeRenewal` re-checks `renewal_order_id` and `cancel_at`, so an
 * extra job charges nothing.
 */
async function enqueueCharge(ctx: Ctx, m: MembershipRow, attempt: 1 | 2 | 3): Promise<void> {
  const periodEndOn = dateKey(m.currentPeriodEndAt);
  const key = renewalJobKey(m.id, periodEndOn, attempt);
  await ctx.enqueue({
    kind: "memberships.charge_renewal",
    payload: { membershipId: m.id, periodEndOn, attempt },
    key: attempt === 1 ? `${key}:v${m.version}` : key,
  });
}

/**
 * Renewal reminders (rules 52 and 56): yearly plans at `yearly_reminder_days` (30, 7); monthly
 * plans at `monthly_reminder_days` (7) only without a valid mandate or when ending; the link path
 * adds the second reminder `renewal_charge_lead_days` (3) before the end. A day `d` is due while
 * `d - 1 <= days left <= d` (a missed scan still sends it once; the dedupe key
 * `membership:<id>:renewal_due:<d>:<period_end>` keeps it to one).
 */
async function sendReminders(tx: DbOrTx, ctx: Ctx, m: MembershipRow, hasMandate: boolean, s: CreditsSettings): Promise<number[]> {
  const isEnding = m.cancelAt !== null;
  const linkPath = !hasMandate && !isEnding;
  const days = new Set<number>(m.interval === "year" ? s.yearly_reminder_days : !hasMandate || isEnding ? s.monthly_reminder_days : []);
  if (linkPath) days.add(s.renewal_charge_lead_days);
  if (m.currentPeriodEndAt.getTime() <= ctx.now.getTime()) return [];
  const left = calendarDaysBetween(brusselsDateOf(ctx.now), brusselsDateOf(m.currentPeriodEndAt));
  const due = [...days].filter((d) => d > 0 && left <= d && left >= d - 1).sort((a, b) => b - a);
  const sent: number[] = [];
  for (const d of due) {
    const amountCents = m.renewalOrderId ? await orderAmount(tx, m.renewalOrderId) : await publicPriceCents(tx, m.productId, ctx.now);
    const recorded = await membershipEvent(ctx, m, "membership.renewal_due", dedupe(m, `renewal_due:${d}`), {
      days: d,
      period_end_on: dateKey(m.currentPeriodEndAt),
      is_ending: isEnding,
      amount_cents: amountCents,
    });
    if (!recorded) continue;
    const payUrl = linkPath && m.renewalOrderId ? (await getPayLinkForOrder(tx as Tx, ctx, { orderId: m.renewalOrderId })).payUrl : undefined;
    await sendMembershipEmail(ctx, m, "membership_renewal_reminder", `${dateKey(m.currentPeriodEndAt)}:${d}`, {
      variant: isEnding ? "ends" : "renews",
      days: d,
      periodEndOn: dateKey(m.currentPeriodEndAt),
      ...(amountCents !== null && !isEnding ? { amountCents } : {}),
      ...(payUrl ? { payUrl } : {}),
    });
    sent.push(d);
  }
  return sent;
}

/** Dunning of a `past_due` membership (rules 50 and 52): retries or link reminders at +3/+7, expiry at +10. */
async function dunningStep(tx: DbOrTx, ctx: Ctx, m: MembershipRow, s: CreditsSettings): Promise<string[]> {
  const sched = dunningSchedule(m.pastDueSinceAt ?? m.currentPeriodEndAt, dunningSettings(s));
  const now = ctx.now.getTime();
  if (now >= sched.expireAt.getTime()) {
    await expireMembership(tx, ctx, m);
    return ["expired"];
  }
  const due: 1 | 2 | 3 = now >= sched.retry3At.getTime() ? 3 : now >= sched.retry2At.getTime() ? 2 : 1;
  if (due <= m.dunningAttempt) return [];
  if (!isLinkPath(m) && (await getActiveMandate(tx, m.personId))) {
    await enqueueCharge(ctx, m, due);
    return [`retry:${due}`];
  }
  const row = await update(tx, ctx, m, { dunningAttempt: due });
  await paymentFailedEmail(tx, ctx, row, due, s);
  return [`link_reminder:${due}`];
}

/**
 * One membership of `memberships.scan_renewals`, under its row lock: activates a due `pending`
 * membership; ends one at `cancel_at`; runs dunning for `past_due`; for `active` enqueues the
 * charge at T-3 (valid mandate) or creates the link renewal order at T-7 and marks it `past_due`
 * when unpaid at period end; sends the renewal reminders. Every step is keyed, so a second run
 * the same day changes nothing.
 */
export async function scanMembership(tx: DbOrTx, ctx: Ctx, membershipId: string, s: CreditsSettings): Promise<string[]> {
  const m = await lockMembership(tx, membershipId);
  const now = ctx.now.getTime();
  if (m.status === "pending") {
    if (m.startedAt.getTime() > now) return [];
    return [await activatePending(tx, ctx, m)];
  }
  if (m.status !== "active" && m.status !== "past_due") return [];
  if (m.cancelAt && m.cancelAt.getTime() <= now) {
    await endAtCancel(tx, ctx, m);
    return ["cancelled"];
  }
  if (m.status === "past_due") return dunningStep(tx, ctx, m, s);

  const done: string[] = [];
  const mandate = await getActiveMandate(tx, m.personId);
  const lead = renewalLeadDates(m.currentPeriodEndAt, { chargeLeadDays: s.renewal_charge_lead_days, linkLeadDays: s.renewal_link_lead_days });
  let row = m;
  if (!m.cancelAt) {
    if (mandate) {
      if (lead.chargeAt.getTime() <= now && !m.renewalOrderId) {
        await enqueueCharge(ctx, m, 1);
        done.push("charge");
      }
    } else {
      if (lead.linkOrderAt.getTime() <= now && !m.renewalOrderId) {
        const order = await createRenewalLinkOrder(tx as Tx, ctx, {
          membershipId: m.id,
          personId: m.personId,
          productId: m.productId,
          periodEndOn: dateKey(m.currentPeriodEndAt),
        });
        row = await update(tx, ctx, m, { renewalOrderId: order.orderId, nextChargeAt: null });
        done.push("link_order");
      }
      if (row.renewalOrderId && row.currentPeriodEndAt.getTime() <= now) {
        await markPastDue(tx, ctx, row);
        done.push("past_due");
        return done;
      }
    }
  }
  for (const d of await sendReminders(tx, ctx, row, !!mandate, s)) done.push(`reminder:${d}`);
  return done;
}

/** The memberships the scan looks at: due `pending`, every `past_due`, and `active` ones near their period end or `cancel_at`. */
export async function scanCandidates(db: DbOrTx, now: Date): Promise<string[]> {
  const horizon = new Date(now.getTime() + 32 * 86_400_000);
  const rows = await db
    .select({ id: memberships.id })
    .from(memberships)
    .where(
      or(
        and(eq(memberships.status, "pending"), lte(memberships.startedAt, now)),
        eq(memberships.status, "past_due"),
        and(eq(memberships.status, "active"), or(lte(memberships.currentPeriodEndAt, horizon), and(isNotNull(memberships.cancelAt), lte(memberships.cancelAt, now)))),
      ),
    )
    .orderBy(asc(memberships.id));
  return rows.map((r) => r.id);
}

/**
 * `memberships.charge_renewal` (rule 48, 50): under the row lock, re-checks the state (attempt 1:
 * `active` without an open renewal order; retries: `past_due` with `dunning_attempt = attempt - 1`
 * and a scheduled `next_charge_at`), the period and the mandate, then calls
 * `commerce.createRecurringCharge` and stores `renewal_order_id` (`next_charge_at` cleared, so a
 * second run charges nothing). No valid mandate: the membership moves to the link path.
 */
export async function chargeRenewal(
  tx: DbOrTx,
  ctx: Ctx,
  input: { membershipId: string; periodEndOn: string; attempt: 1 | 2 | 3 },
): Promise<{ charged: boolean; reason?: string; orderId?: string }> {
  const m = await lockMembership(tx, input.membershipId);
  if ((m.status !== "active" && m.status !== "past_due") || m.cancelAt) return { charged: false, reason: `membership_${m.cancelAt ? "ending" : m.status}` };
  if (dateKey(m.currentPeriodEndAt) !== input.periodEndOn) return { charged: false, reason: "period_moved" };
  if (input.attempt === 1 && (m.status !== "active" || m.renewalOrderId)) return { charged: false, reason: "already_charged" };
  if (input.attempt > 1 && (m.status !== "past_due" || m.dunningAttempt !== input.attempt - 1 || m.nextChargeAt === null)) {
    return { charged: false, reason: "not_due" };
  }
  const mandate = await getActiveMandate(tx, m.personId);
  if (!mandate) {
    await update(tx, ctx, m, { mandateId: null, nextChargeAt: null });
    return { charged: false, reason: "no_mandate" };
  }
  const r = await createRecurringCharge(tx as Tx, ctx, {
    membershipId: m.id,
    personId: m.personId,
    productId: m.productId,
    mandateId: mandate.mandateId,
    periodEndOn: input.periodEndOn,
  });
  await update(tx, ctx, m, { renewalOrderId: r.orderId, mandateId: mandate.mandateId, nextChargeAt: null });
  return { charged: true, orderId: r.orderId };
}

/**
 * credits staff queries (credits spec section 4 "Queries", credits-P6). Every function takes the
 * caller's `db`/`tx` first and reads through it (OD-15); the page checks the permission
 * (`credits.read`, or `memberships.write` for the membership screens) before calling. Balances
 * come from `v_credit_grant_balances`; nothing here writes. Lists use keyset cursors (opaque
 * base64 of the sort key and id). Staff see full names, actors and reasons (rule 39); notes stay
 * on the detail screens only.
 */
import type { DbOrTx } from "@beam/db";
import {
  activityEvents,
  bookings,
  creditBulkExtensions,
  creditEntries,
  creditGrants,
  creditReconciliationRuns,
  mandates,
  membershipPeriods,
  membershipPlanBenefits,
  membershipPlanInclusions,
  memberships,
  orders,
  packageShares,
  payments,
  persons,
  products,
  sessions,
  users,
  vCreditGrantBalances,
  vCreditLiability,
  vouchers,
} from "@beam/db/schema";
import { brusselsMonthWindow } from "./server/ledger";
import type { CreditKind } from "@beam/core/credits";
import { messagesFor, type Locale, type LocalizedText } from "@beam/core/i18n";
import { and, asc, desc, eq, inArray, NotFoundError, sql, type SQL } from "@/lib/ctx";
import { previewBulkExtension as previewBulk, type BulkExtensionFilter } from "./server/bulk-extend";
import { getPersonCreditSummary } from "./server/ledger";

export type GrantStatus = "active" | "exhausted" | "expired" | "revoked";
export type GrantSource = "purchase" | "voucher" | "membership" | "bonus" | "import" | "manual" | "referral" | "transfer";
export type MembershipStatus = "pending" | "active" | "past_due" | "cancelled" | "expired";
export type Attendance = "upcoming" | "attended" | "no_show" | "cancelled" | "late_cancelled";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

const personName = sql<string>`btrim(coalesce(${persons.firstName}, '') || ' ' || coalesce(${persons.lastName}, ''))`;

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString("base64url");
}

function decodeCursor(cursor: string | undefined | null): { at: Date; id: string } | null {
  if (!cursor) return null;
  const [iso, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!iso || !id || !UUID_RE.test(id) || Number.isNaN(Date.parse(iso))) return null;
  return { at: new Date(iso), id };
}

/** The flat strings of `credits.<group>` for client components (ui takes every string as a prop). */
export function creditsLabels(locale: Locale, groups: readonly string[]): Record<string, string> {
  const tree = (messagesFor(locale, ["credits"]).credits ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const group of groups) {
    let node: unknown = tree;
    for (const part of group.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
    if (!node || typeof node !== "object") continue;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

export type GrantListRow = {
  grantId: string;
  personId: string;
  personName: string;
  productName: LocalizedText | null;
  label: LocalizedText | null;
  kind: CreditKind;
  remainingUnits: number;
  baseUnits: number;
  status: GrantStatus;
  source: GrantSource;
  startsAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
};

export type ListGrantsInput = {
  q?: string;
  kind?: CreditKind;
  status?: GrantStatus;
  source?: GrantSource;
  expiringWithinDays?: number;
  personId?: string;
  cursor?: string | null;
  limit?: number;
  now?: Date;
};

/** `/admin/credits`: grants newest first with balance, filters and search by name or email. */
export async function listGrants(db: DbOrTx, input: ListGrantsInput = {}): Promise<{ rows: GrantListRow[]; nextCursor: string | null }> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const now = input.now ?? new Date();
  const where: SQL[] = [];
  if (input.kind) where.push(eq(creditGrants.creditKind, input.kind));
  if (input.status) where.push(eq(creditGrants.status, input.status));
  if (input.source) where.push(eq(creditGrants.source, input.source));
  if (input.personId && UUID_RE.test(input.personId)) where.push(eq(creditGrants.personId, input.personId));
  if (input.expiringWithinDays) {
    const until = new Date(now.getTime() + input.expiringWithinDays * DAY);
    where.push(
      eq(creditGrants.status, "active"),
      sql`${creditGrants.expiresAt} > ${now.toISOString()}::timestamptz and ${creditGrants.expiresAt} <= ${until.toISOString()}::timestamptz`,
      sql`${vCreditGrantBalances.remainingUnits} > 0`,
    );
  }
  const q = input.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(${personName} ilike ${like} or ${persons.email} ilike ${like})`);
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) where.push(sql`(${creditGrants.createdAt}, ${creditGrants.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`);

  const rows = await db
    .select({
      grantId: creditGrants.id,
      personId: creditGrants.personId,
      personName,
      productName: products.name,
      label: creditGrants.label,
      kind: creditGrants.creditKind,
      remainingUnits: vCreditGrantBalances.remainingUnits,
      baseUnits: vCreditGrantBalances.baseUnits,
      status: creditGrants.status,
      source: creditGrants.source,
      startsAt: creditGrants.startsAt,
      expiresAt: creditGrants.expiresAt,
      lastUsedAt: vCreditGrantBalances.lastUsedAt,
      createdAt: creditGrants.createdAt,
    })
    .from(creditGrants)
    .innerJoin(vCreditGrantBalances, eq(vCreditGrantBalances.grantId, creditGrants.id))
    .innerJoin(persons, eq(persons.id, creditGrants.personId))
    .leftJoin(products, eq(products.id, creditGrants.productId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(creditGrants.createdAt), desc(creditGrants.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit).map((r) => ({ ...r, remainingUnits: Number(r.remainingUnits), baseUnits: Number(r.baseUnits), lastUsedAt: r.lastUsedAt ? new Date(r.lastUsedAt) : null }));
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.grantId) : null };
}

export type LedgerRow = {
  entryId: string;
  createdAt: Date;
  kind: string;
  quantity: number;
  runningBalance: number;
  reason: string | null;
  refType: string | null;
  refId: string | null;
  beneficiaryPersonId: string | null;
  beneficiaryName: string | null;
  actorKind: string;
  actorName: string | null;
  bookingId: string | null;
  sessionTitle: LocalizedText | null;
  sessionStartsAt: Date | null;
  attendance: Attendance | null;
  isReleased: boolean;
};

export type GuestRow = { personId: string; name: string; uses: number; lastUsedAt: Date; attendance: { sessionStartsAt: Date | null; attendance: Attendance | null }[] };

export type GrantDetail = {
  grant: typeof creditGrants.$inferSelect;
  personName: string;
  productName: LocalizedText | null;
  balance: { remainingUnits: number; baseUnits: number; usedUnits: number; guestUnits: number; expiredUnits: number; adjustedUnits: number; isUsable: boolean };
  entries: LedgerRow[];
  guests: GuestRow[];
  guestUsesThisMonth: number;
  shares: { shareId: string; personId: string; name: string; maxUnits: number | null; status: string; createdAt: Date }[];
  voucherLast4: string | null;
};

/** The attendance of a credit use, from the booking and its session (rule 37). */
export function attendanceOf(bookingStatus: string | null, sessionStartsAt: Date | null, now: Date): Attendance | null {
  if (!bookingStatus) return null;
  if (bookingStatus === "attended") return "attended";
  if (bookingStatus === "no_show") return "no_show";
  if (bookingStatus === "cancelled") return "cancelled";
  if (bookingStatus === "late_cancelled") return "late_cancelled";
  return sessionStartsAt && sessionStartsAt.getTime() < now.getTime() ? "attended" : "upcoming";
}

/** `/admin/credits/grants/[grantId]`: the grant, its balance, the ledger with running balance, guests and shares. */
export async function getGrant(db: DbOrTx, grantId: string, opts: { now?: Date } = {}): Promise<GrantDetail> {
  if (!UUID_RE.test(grantId)) throw new NotFoundError("grant_not_found");
  const now = opts.now ?? new Date();
  const [head] = await db
    .select({
      grant: creditGrants,
      personName,
      productName: products.name,
      b: {
        remainingUnits: vCreditGrantBalances.remainingUnits,
        baseUnits: vCreditGrantBalances.baseUnits,
        usedUnits: vCreditGrantBalances.usedUnits,
        guestUnits: vCreditGrantBalances.guestUnits,
        expiredUnits: vCreditGrantBalances.expiredUnits,
        adjustedUnits: vCreditGrantBalances.adjustedUnits,
        isUsable: vCreditGrantBalances.isUsable,
      },
    })
    .from(creditGrants)
    .innerJoin(persons, eq(persons.id, creditGrants.personId))
    .innerJoin(vCreditGrantBalances, eq(vCreditGrantBalances.grantId, creditGrants.id))
    .leftJoin(products, eq(products.id, creditGrants.productId))
    .where(eq(creditGrants.id, grantId));
  if (!head) throw new NotFoundError("grant_not_found");

  const beneficiary = sql<string | null>`(select btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')) from persons p where p.id = ${creditEntries.beneficiaryPersonId})`;
  const actorName = sql<string | null>`(select u.name from users u where u.id::text = ${creditEntries.actor}->>'id')`;
  const released = sql<boolean>`exists (select 1 from credit_entries r where r.reverses_entry_id = ${creditEntries.id})`;
  const raw = await db
    .select({
      entryId: creditEntries.id,
      createdAt: creditEntries.createdAt,
      kind: creditEntries.kind,
      quantity: creditEntries.quantity,
      reason: creditEntries.reason,
      refType: creditEntries.refType,
      refId: creditEntries.refId,
      beneficiaryPersonId: creditEntries.beneficiaryPersonId,
      beneficiaryName: beneficiary,
      actor: creditEntries.actor,
      actorName,
      bookingStatus: bookings.status,
      bookingId: bookings.id,
      sessionTitle: sessions.title,
      sessionStartsAt: sessions.startsAt,
      isReleased: released,
    })
    .from(creditEntries)
    .leftJoin(bookings, and(eq(creditEntries.refType, "booking"), eq(bookings.id, creditEntries.refId)))
    .leftJoin(sessions, eq(sessions.id, bookings.sessionId))
    .where(eq(creditEntries.grantId, grantId))
    .orderBy(asc(creditEntries.createdAt), asc(creditEntries.id));
  let running = 0;
  const entries: LedgerRow[] = raw.map((e) => {
    running += e.quantity;
    const actor = (e.actor ?? {}) as { kind?: string };
    return {
      entryId: e.entryId,
      createdAt: e.createdAt,
      kind: e.kind,
      quantity: e.quantity,
      runningBalance: running,
      reason: e.reason,
      refType: e.refType,
      refId: e.refId,
      beneficiaryPersonId: e.beneficiaryPersonId,
      beneficiaryName: e.beneficiaryName,
      actorKind: actor.kind ?? "system",
      actorName: e.actorName,
      bookingId: e.bookingId,
      sessionTitle: e.sessionTitle,
      sessionStartsAt: e.sessionStartsAt,
      attendance: attendanceOf(e.bookingStatus, e.sessionStartsAt, now),
      isReleased: Boolean(e.isReleased),
    };
  });

  const owner = head.grant.personId;
  const guestMap = new Map<string, GuestRow>();
  for (const e of entries) {
    if (e.kind !== "consume" || !e.beneficiaryPersonId || e.beneficiaryPersonId === owner) continue;
    const g = guestMap.get(e.beneficiaryPersonId) ?? { personId: e.beneficiaryPersonId, name: e.beneficiaryName ?? "", uses: 0, lastUsedAt: e.createdAt, attendance: [] };
    if (!e.isReleased) g.uses += 1;
    g.lastUsedAt = e.createdAt;
    g.attendance.push({ sessionStartsAt: e.sessionStartsAt, attendance: e.isReleased ? "cancelled" : e.attendance });
    guestMap.set(e.beneficiaryPersonId, g);
  }
  const month = brusselsMonthWindow(now);
  const guestRefs = new Set(
    entries
      .filter((e) => e.kind === "consume" && !e.isReleased && e.beneficiaryPersonId && e.beneficiaryPersonId !== owner && e.createdAt >= month.from && e.createdAt < month.to)
      .map((e) => e.refId),
  );

  const shareRows = await db
    .select({ shareId: packageShares.id, personId: packageShares.sharedWithPersonId, name: personName, maxUnits: packageShares.maxUnits, status: packageShares.status, createdAt: packageShares.createdAt })
    .from(packageShares)
    .innerJoin(persons, eq(persons.id, packageShares.sharedWithPersonId))
    .where(eq(packageShares.grantId, grantId))
    .orderBy(desc(packageShares.createdAt));

  let voucherLast4: string | null = null;
  if (head.grant.voucherId) {
    const [v] = await db.select({ last4: vouchers.codeLast4 }).from(vouchers).where(eq(vouchers.id, head.grant.voucherId));
    voucherLast4 = v?.last4 ?? null;
  }
  const b = head.b;
  return {
    grant: head.grant,
    personName: head.personName,
    productName: head.productName,
    balance: {
      remainingUnits: Number(b.remainingUnits),
      baseUnits: Number(b.baseUnits),
      usedUnits: Number(b.usedUnits),
      guestUnits: Number(b.guestUnits),
      expiredUnits: Number(b.expiredUnits),
      adjustedUnits: Number(b.adjustedUnits),
      isUsable: Boolean(b.isUsable),
    },
    entries,
    guests: [...guestMap.values()].sort((a, z) => z.lastUsedAt.getTime() - a.lastUsedAt.getTime()),
    guestUsesThisMonth: guestRefs.size,
    shares: shareRows,
    voucherLast4,
  };
}

/** The crm person page and the desk: totals per kind, the live membership, status and the usable grants. */
export async function getPersonCredits(db: DbOrTx, personId: string) {
  const summary = await getPersonCreditSummary(db, personId);
  const grants = await db
    .select({
      grantId: vCreditGrantBalances.grantId,
      kind: vCreditGrantBalances.creditKind,
      status: vCreditGrantBalances.status,
      source: vCreditGrantBalances.source,
      remainingUnits: vCreditGrantBalances.remainingUnits,
      baseUnits: vCreditGrantBalances.baseUnits,
      startsAt: vCreditGrantBalances.startsAt,
      expiresAt: vCreditGrantBalances.expiresAt,
      productName: products.name,
      label: creditGrants.label,
    })
    .from(vCreditGrantBalances)
    .innerJoin(creditGrants, eq(creditGrants.id, vCreditGrantBalances.grantId))
    .leftJoin(products, eq(products.id, vCreditGrantBalances.productId))
    .where(and(eq(vCreditGrantBalances.personId, personId), eq(vCreditGrantBalances.status, "active")))
    .orderBy(sql`${vCreditGrantBalances.expiresAt} asc nulls last`, asc(vCreditGrantBalances.grantId));
  return {
    ...summary,
    activeGrants: grants.map((g) => ({ ...g, remainingUnits: Number(g.remainingUnits), baseUnits: Number(g.baseUnits) })),
  };
}

// ---------------------------------------------------------------------------
// Bulk extensions and reconciliation
// ---------------------------------------------------------------------------

/** The live preview of the bulk-extension form: how many grants the filter matches now. */
export function previewBulkExtension(db: DbOrTx, filter: BulkExtensionFilter): Promise<{ matched: number }> {
  return previewBulk(db, filter);
}

export async function listBulkExtensions(db: DbOrTx, opts: { limit?: number } = {}) {
  return db
    .select({
      id: creditBulkExtensions.id,
      reason: creditBulkExtensions.reason,
      days: creditBulkExtensions.days,
      filter: creditBulkExtensions.filter,
      status: creditBulkExtensions.status,
      matchedCount: creditBulkExtensions.matchedCount,
      extendedCount: creditBulkExtensions.extendedCount,
      createdAt: creditBulkExtensions.createdAt,
      finishedAt: creditBulkExtensions.finishedAt,
      createdByName: users.name,
    })
    .from(creditBulkExtensions)
    .leftJoin(users, eq(users.id, creditBulkExtensions.createdByUserId))
    .orderBy(desc(creditBulkExtensions.createdAt))
    .limit(Math.min(100, Math.max(1, opts.limit ?? 20)));
}

export async function listReconciliationRuns(db: DbOrTx, opts: { limit?: number } = {}) {
  return db
    .select()
    .from(creditReconciliationRuns)
    .orderBy(desc(creditReconciliationRuns.startedAt))
    .limit(Math.min(100, Math.max(1, opts.limit ?? 30)));
}

// ---------------------------------------------------------------------------
// Membership plans and memberships
// ---------------------------------------------------------------------------

/** `/admin/memberships/plans`: membership products with their primary and extra inclusions, benefits and live members. */
export async function listPlans(db: DbOrTx) {
  const plans = await db
    .select({
      productId: products.id,
      name: products.name,
      sku: products.sku,
      isActive: products.isActive,
      interval: products.recurringInterval,
      includedCreditKind: products.includedCreditKind,
      includedCreditUnits: products.includedCreditUnits,
      memberDiscountPct: products.memberDiscountPct,
      activeMembers: sql<number>`(select count(*)::int from memberships m where m.product_id = ${products.id} and m.status in ('active', 'past_due'))`,
    })
    .from(products)
    .where(eq(products.kind, "membership"))
    .orderBy(asc(products.sku));
  const ids = plans.map((p) => p.productId);
  const inclusions = ids.length
    ? await db.select().from(membershipPlanInclusions).where(inArray(membershipPlanInclusions.productId, ids)).orderBy(asc(membershipPlanInclusions.creditKind))
    : [];
  const benefits = ids.length
    ? await db
        .select()
        .from(membershipPlanBenefits)
        .where(inArray(membershipPlanBenefits.productId, ids))
        .orderBy(asc(membershipPlanBenefits.sortOrder), asc(membershipPlanBenefits.createdAt))
    : [];
  return plans.map((p) => {
    const extra = inclusions.filter((i) => i.productId === p.productId);
    const kinds = new Set([p.includedCreditKind, ...extra.filter((i) => i.isActive).map((i) => i.creditKind)].filter(Boolean));
    return {
      ...p,
      activeMembers: Number(p.activeMembers),
      memberDiscountPct: Number(p.memberDiscountPct ?? 0),
      inclusions: extra,
      benefits: benefits.filter((b) => b.productId === p.productId),
      mixedVat: kinds.has("day") && kinds.has("night"),
    };
  });
}

export type MembershipListRow = {
  membershipId: string;
  personId: string;
  personName: string;
  planName: LocalizedText;
  productId: string;
  status: MembershipStatus;
  currentPeriodEndAt: Date;
  nextChargeAt: Date | null;
  dunningAttempt: number;
  cancelAt: Date | null;
  createdAt: Date;
};

/** `/admin/memberships` and the ops past-due list (`status: 'past_due'`, rule 50a). */
export async function listMemberships(
  db: DbOrTx,
  input: { status?: MembershipStatus; plan?: string; renewingWithinDays?: number; q?: string; cursor?: string | null; limit?: number; now?: Date } = {},
): Promise<{ rows: MembershipListRow[]; nextCursor: string | null }> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const now = input.now ?? new Date();
  const where: SQL[] = [];
  if (input.status) where.push(eq(memberships.status, input.status));
  if (input.plan && UUID_RE.test(input.plan)) where.push(eq(memberships.productId, input.plan));
  if (input.renewingWithinDays) {
    const until = new Date(now.getTime() + input.renewingWithinDays * DAY);
    where.push(
      eq(memberships.status, "active"),
      sql`${memberships.cancelAt} is null`,
      sql`${memberships.currentPeriodEndAt} > ${now.toISOString()}::timestamptz and ${memberships.currentPeriodEndAt} <= ${until.toISOString()}::timestamptz`,
    );
  }
  const q = input.q?.trim();
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(${personName} ilike ${like} or ${persons.email} ilike ${like})`);
  }
  const cursor = decodeCursor(input.cursor);
  if (cursor) where.push(sql`(${memberships.createdAt}, ${memberships.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`);
  const rows = await db
    .select({
      membershipId: memberships.id,
      personId: memberships.personId,
      personName,
      planName: products.name,
      productId: memberships.productId,
      status: memberships.status,
      currentPeriodEndAt: memberships.currentPeriodEndAt,
      nextChargeAt: memberships.nextChargeAt,
      dunningAttempt: memberships.dunningAttempt,
      cancelAt: memberships.cancelAt,
      createdAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(persons, eq(persons.id, memberships.personId))
    .innerJoin(products, eq(products.id, memberships.productId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(memberships.createdAt), desc(memberships.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { rows: page, nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.membershipId) : null };
}

/** `/admin/memberships/[membershipId]`: plan, periods, this period's included grants, renewal orders, mandate and timeline. */
export async function getMembership(db: DbOrTx, membershipId: string) {
  if (!UUID_RE.test(membershipId)) throw new NotFoundError("membership_not_found");
  const [head] = await db
    .select({ m: memberships, personName, planName: products.name, interval: products.recurringInterval })
    .from(memberships)
    .innerJoin(persons, eq(persons.id, memberships.personId))
    .innerJoin(products, eq(products.id, memberships.productId))
    .where(eq(memberships.id, membershipId));
  if (!head) throw new NotFoundError("membership_not_found");
  const m = head.m;
  const periods = await db
    .select({
      id: membershipPeriods.id,
      periodStartAt: membershipPeriods.periodStartAt,
      periodEndAt: membershipPeriods.periodEndAt,
      source: membershipPeriods.source,
      orderId: membershipPeriods.orderId,
      amountCents: membershipPeriods.amountCents,
    })
    .from(membershipPeriods)
    .where(eq(membershipPeriods.membershipId, m.id))
    .orderBy(desc(membershipPeriods.periodStartAt));
  const grants = await db
    .select({
      grantId: vCreditGrantBalances.grantId,
      kind: vCreditGrantBalances.creditKind,
      status: vCreditGrantBalances.status,
      remainingUnits: vCreditGrantBalances.remainingUnits,
      baseUnits: vCreditGrantBalances.baseUnits,
      startsAt: vCreditGrantBalances.startsAt,
      expiresAt: vCreditGrantBalances.expiresAt,
    })
    .from(vCreditGrantBalances)
    .where(and(eq(vCreditGrantBalances.membershipId, m.id), sql`${vCreditGrantBalances.startsAt} >= ${m.currentPeriodStartAt.toISOString()}::timestamptz`))
    .orderBy(asc(vCreditGrantBalances.creditKind));
  const orderIds = [m.firstOrderId, m.renewalOrderId, ...periods.map((p) => p.orderId)].filter((x): x is string => !!x);
  const orderRows = await db
    .select({ orderId: orders.id, reference: orders.reference, status: orders.status, totalCents: orders.totalCents, createdAt: orders.createdAt })
    .from(orders)
    .where(orderIds.length ? sql`(${inArray(orders.id, orderIds)} or ${orders.renewalMembershipId} = ${m.id})` : eq(orders.renewalMembershipId, m.id))
    .orderBy(desc(orders.createdAt));
  const payRows = orderRows.length
    ? await db
        .select({ orderId: payments.orderId, status: payments.status, amountCents: payments.amountCents, createdAt: payments.createdAt })
        .from(payments)
        .where(inArray(payments.orderId, orderRows.map((o) => o.orderId)))
        .orderBy(desc(payments.createdAt))
    : [];
  const [mandate] = m.mandateId ? await db.select({ id: mandates.id, status: mandates.status }).from(mandates).where(eq(mandates.id, m.mandateId)) : [];
  const timeline = await db
    .select({ kind: activityEvents.kind, occurredAt: activityEvents.occurredAt })
    .from(activityEvents)
    .where(and(eq(activityEvents.refType, "membership"), eq(activityEvents.refId, m.id)))
    .orderBy(desc(activityEvents.occurredAt))
    .limit(100);
  return {
    membership: m,
    personName: head.personName,
    planName: head.planName,
    periods,
    currentGrants: grants.map((g) => ({ ...g, remainingUnits: Number(g.remainingUnits), baseUnits: Number(g.baseUnits) })),
    orders: orderRows.map((o) => ({ ...o, payments: payRows.filter((p) => p.orderId === o.orderId) })),
    mandate: mandate ?? null,
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Tiles and the desk badge
// ---------------------------------------------------------------------------

/** The `/admin/credits` tiles and ops' action dashboard tiles (spec section 5). */
export async function getCreditsTiles(db: DbOrTx, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const in30 = new Date(now.getTime() + 30 * DAY).toISOString();
  const iso = now.toISOString();
  const b = vCreditGrantBalances;
  const live = sql`${b.status} = 'active' and ${b.remainingUnits} > 0`;
  const [g] = await db
    .select({
      activeGrants: sql<number>`(count(*) filter (where ${live}))::int`,
      expiring30: sql<number>`(count(*) filter (where ${live} and ${b.expiresAt} > ${iso}::timestamptz and ${b.expiresAt} <= ${in30}::timestamptz))::int`,
      nearlyFinished: sql<number>`(count(*) filter (where ${live} and ${b.source} in ('purchase', 'import', 'transfer') and ${b.creditKind} <> 'euro' and ${b.usedUnits} * 100 >= ${b.baseUnits} * 80))::int`,
    })
    .from(b);
  const liability = await db
    .select({ kind: vCreditLiability.creditKind, units: sql<number>`sum(${vCreditLiability.remainingUnits})::bigint`, valueCents: sql<number>`sum(${vCreditLiability.remainingValueCents})::bigint` })
    .from(vCreditLiability)
    .groupBy(vCreditLiability.creditKind);
  const [m] = await db
    .select({
      renewing30: sql<number>`(count(*) filter (where ${memberships.status} = 'active' and ${memberships.cancelAt} is null and ${memberships.currentPeriodEndAt} > ${iso}::timestamptz and ${memberships.currentPeriodEndAt} <= ${in30}::timestamptz))::int`,
      pastDue: sql<number>`(count(*) filter (where ${memberships.status} = 'past_due'))::int`,
    })
    .from(memberships);
  const order: CreditKind[] = ["day", "night", "euro"];
  const outstanding = order.map((kind) => {
    const row = liability.find((l) => l.kind === kind);
    return { kind, units: Number(row?.units ?? 0), valueCents: Number(row?.valueCents ?? 0) };
  });
  return {
    activeGrants: Number(g?.activeGrants ?? 0),
    expiringIn30Days: Number(g?.expiring30 ?? 0),
    nearlyFinished: Number(g?.nearlyFinished ?? 0),
    outstanding,
    outstandingValueCents: outstanding.reduce((n, o) => n + o.valueCents, 0),
    membershipsRenewingIn30Days: Number(m?.renewing30 ?? 0),
    pastDueMemberships: Number(m?.pastDue ?? 0),
  };
}

export type CreditsTiles = Awaited<ReturnType<typeof getCreditsTiles>>;

/** One line for the check-in desk and the POS (`DeskCreditsBadge`): usable units per kind and the membership. */
export async function getDeskCredits(db: DbOrTx, personId: string) {
  const s = await getPersonCreditSummary(db, personId);
  return { byKind: s.byKind, membership: s.membership, status: s.status };
}

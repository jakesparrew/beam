/**
 * credits staff queries (credits spec section 4 "Queries", credits-P6). Every function takes the
 * caller's `db`/`tx` first and reads through it (OD-15); the page checks the permission
 * (`credits.read`, or `memberships.write` for the membership screens) before calling. Balances
 * come from `v_credit_grant_balances`; nothing here writes. Lists use keyset cursors (opaque
 * base64 of the sort key and id). Staff see full names, actors and reasons (rule 39); notes stay
 * on the detail screens only. credits-P7 adds the customer queries (`getMyPackages`,
 * `getMyPackage`, `getMyMembership`, `listGrantsSharedWith`): the page passes the signed-in
 * customer's own `personId`, and nothing staff-only (unit values, VAT, reasons, actors, notes)
 * is selected for them (rules 37 and 38).
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
import { getMySharesGiven, listSharingReview as listReviewRows, MAX_PORTAL_SHARES, personNames, type MyShareRow, type SharingReviewRow } from "./server/sharing";

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

/**
 * The raw strings of the `credits.<group>` catalogue groups for client components (ui takes every
 * string as a prop), keyed by their path below `credits` (`admin.common.cancel`). Messages with
 * plurals are formatted on the server; client components only fill simple `{name}` slots.
 */
export function creditsLabels(locale: Locale, groups: readonly string[]): Record<string, string> {
  const tree = (messagesFor(locale, ["credits"]).credits ?? {}) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const group of groups) {
    let node: unknown = tree;
    for (const part of group.split(".")) node = node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined;
    if (!node || typeof node !== "object") continue;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) if (typeof v === "string") out[`${group}.${k}`] = v;
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

// ---------------------------------------------------------------------------
// Customer portal (credits-P7): own data only, the caller passes the actor's personId
// ---------------------------------------------------------------------------

/** One package as the customer sees it (rule 37: no unit values, VAT, notes or reasons). */
export type MyPackage = {
  grantId: string;
  kind: CreditKind;
  source: GrantSource;
  status: GrantStatus;
  productName: LocalizedText | null;
  label: LocalizedText | null;
  remainingUnits: number;
  baseUnits: number;
  startsAt: Date;
  expiresAt: Date | null;
  statusChangedAt: Date;
};

/** A package another customer shared with the reader (R2 named sharing; rule 38 owner name). */
export type SharedPackage = MyPackage & { shareId: string; ownerName: string; maxUnits: number | null; usedByMe: number; unitsForMe: number };

export type MyPackages = {
  active: MyPackage[];
  upcoming: MyPackage[];
  history: MyPackage[];
  sharedWithMe: SharedPackage[];
  storeCredit: { remainingCents: number; earliestExpiresAt: Date | null; grants: MyPackage[] };
};

/** "Anna D.": a guest or an owner as another customer sees them (rule 38). */
export function firstNameAndInitial(firstName: string | null, lastName: string | null): string {
  const first = (firstName ?? "").trim();
  const initial = (lastName ?? "").trim().charAt(0).toUpperCase();
  return [first, initial ? `${initial}.` : ""].filter(Boolean).join(" ");
}

const HISTORY_LIMIT = 50;

function myPackageColumns() {
  return {
    grantId: vCreditGrantBalances.grantId,
    kind: vCreditGrantBalances.creditKind,
    source: vCreditGrantBalances.source,
    status: vCreditGrantBalances.status,
    productName: products.name,
    label: creditGrants.label,
    remainingUnits: vCreditGrantBalances.remainingUnits,
    baseUnits: vCreditGrantBalances.baseUnits,
    startsAt: vCreditGrantBalances.startsAt,
    expiresAt: vCreditGrantBalances.expiresAt,
    statusChangedAt: creditGrants.statusChangedAt,
  };
}

function toMyPackage<T extends { remainingUnits: number; baseUnits: number }>(r: T): T {
  return { ...r, remainingUnits: Number(r.remainingUnits), baseUnits: Number(r.baseUnits) };
}

/**
 * The grants named-shared with `personId` (active `package_shares` on an active grant of someone
 * else), with what the reader may still use: the grant's remaining units capped by the share's
 * `max_units` minus the reader's unreleased uses. The portal booking form offers these as "use a
 * package shared with me" (booking-P6 request); `getMyPackages` lists them as "Shared with me".
 */
export async function listGrantsSharedWith(db: DbOrTx, personId: string): Promise<SharedPackage[]> {
  if (!UUID_RE.test(personId)) return [];
  // Net units the reader used on the grant (consumes minus returns), as the ledger caps `max_units` (rule 18).
  const usedByMe = sql<number>`(select coalesce(-sum(e.quantity), 0)::int from credit_entries e where e.grant_id = ${packageShares.grantId} and e.kind in ('consume', 'release') and e.beneficiary_person_id = ${personId})`;
  const rows = await db
    .select({
      ...myPackageColumns(),
      shareId: packageShares.id,
      maxUnits: packageShares.maxUnits,
      ownerFirst: persons.firstName,
      ownerLast: persons.lastName,
      usedByMe,
    })
    .from(packageShares)
    .innerJoin(creditGrants, eq(creditGrants.id, packageShares.grantId))
    .innerJoin(vCreditGrantBalances, eq(vCreditGrantBalances.grantId, packageShares.grantId))
    .innerJoin(persons, eq(persons.id, creditGrants.personId))
    .leftJoin(products, eq(products.id, creditGrants.productId))
    .where(
      and(
        eq(packageShares.sharedWithPersonId, personId),
        eq(packageShares.status, "active"),
        eq(creditGrants.status, "active"),
        sql`${creditGrants.personId} <> ${personId}`,
      ),
    )
    .orderBy(sql`${vCreditGrantBalances.expiresAt} asc nulls last`, asc(packageShares.grantId));
  return rows.map(({ ownerFirst, ownerLast, ...r }) => {
    const p = toMyPackage(r);
    const used = Number(r.usedByMe);
    const cap = r.maxUnits == null ? p.remainingUnits : Math.max(0, r.maxUnits - used);
    return { ...p, usedByMe: used, unitsForMe: Math.max(0, Math.min(p.remainingUnits, cap)), ownerName: firstNameAndInitial(ownerFirst, ownerLast) };
  });
}

/**
 * `/[locale]/account/packages`: the reader's own day and night packages that are usable now
 * (`active`), that start later (`upcoming`) and the closed ones (`history`, newest first, at most
 * 50); every usable euro grant is summed into one store-credit card with the earliest expiry;
 * `sharedWithMe` from `listGrantsSharedWith`.
 */
export async function getMyPackages(db: DbOrTx, personId: string, opts: { now?: Date } = {}): Promise<MyPackages> {
  if (!UUID_RE.test(personId)) throw new NotFoundError("person_not_found");
  const now = opts.now ?? new Date();
  const rows = (
    await db
      .select(myPackageColumns())
      .from(vCreditGrantBalances)
      .innerJoin(creditGrants, eq(creditGrants.id, vCreditGrantBalances.grantId))
      .leftJoin(products, eq(products.id, vCreditGrantBalances.productId))
      .where(eq(vCreditGrantBalances.personId, personId))
      .orderBy(sql`${vCreditGrantBalances.expiresAt} asc nulls last`, asc(vCreditGrantBalances.startsAt), asc(vCreditGrantBalances.grantId))
  ).map(toMyPackage);
  const live = (r: MyPackage) => r.status === "active" && (r.expiresAt === null || r.expiresAt.getTime() > now.getTime());
  const started = (r: MyPackage) => r.startsAt.getTime() <= now.getTime();
  const euro = rows.filter((r) => r.kind === "euro" && live(r) && started(r) && r.remainingUnits > 0);
  const expiries = euro.map((r) => r.expiresAt).filter((d): d is Date => d !== null);
  return {
    active: rows.filter((r) => r.kind !== "euro" && live(r) && started(r) && r.remainingUnits > 0),
    upcoming: rows.filter((r) => live(r) && !started(r)),
    history: rows
      .filter((r) => !live(r) || (r.kind !== "euro" && started(r) && r.remainingUnits <= 0))
      .sort((a, z) => z.statusChangedAt.getTime() - a.statusChangedAt.getTime())
      .slice(0, HISTORY_LIMIT),
    sharedWithMe: await listGrantsSharedWith(db, personId),
    storeCredit: {
      remainingCents: euro.reduce((n, r) => n + r.remainingUnits, 0),
      earliestExpiresAt: expiries.length ? new Date(Math.min(...expiries.map((d) => d.getTime()))) : null,
      grants: euro,
    },
  };
}

/** One line of the customer's usage history of a package (rule 37). */
export type MyUsageRow = {
  entryId: string;
  at: Date;
  kind: "use" | "returned" | "expired" | "adjusted" | "extended" | "revoked" | "transferred";
  /** Signed units (cents for store credit); 0 for an extension. */
  quantity: number;
  sessionTitle: LocalizedText | null;
  sessionStartsAt: Date | null;
  /** Who used it: the reader, or a guest as first name and initial (rule 38); null for non-use lines. */
  usedBy: { you: true } | { you: false; name: string } | null;
  attendance: Attendance | null;
  /** A use that was later returned (cancellation in the window, rule 19). */
  returned: boolean;
  newExpiresAt: Date | null;
  orderReference: string | null;
};

export type MyPackageDetail = {
  package: MyPackage;
  isOwner: boolean;
  /** The package starts later (`starts_at` after now). */
  upcoming: boolean;
  ownerName: string | null;
  sharingMode: "none" | "guests" | "named";
  usage: MyUsageRow[];
  /** Guest uses still possible this Brussels month (owner of a `guests` grant), else null. */
  guestUsesLeft: number | null;
  /** Store credit: the orders paid with it (date, reference, amount), returned payments left out. */
  orders: { orderId: string; reference: string; at: Date; amountCents: number }[];
};

const USAGE_KIND: Partial<Record<string, MyUsageRow["kind"]>> = {
  consume: "use",
  release: "returned",
  expire: "expired",
  adjust: "adjusted",
  extend: "extended",
  revoke: "revoked",
  transfer_out: "transferred",
};

/**
 * `/[locale]/account/packages/[grantId]`: a package of the reader, or one shared with them through
 * an active share (`NotFoundError` otherwise, the standard portal 404). The owner sees every use
 * with guests as first name and initial and their attendance; a sharee sees only their own uses.
 * Staff reasons, actors and unit values never leave this function (rule 37): an adjustment is the
 * generic "Adjusted by BEAM" line.
 */
export async function getMyPackage(db: DbOrTx, personId: string, grantId: string, opts: { now?: Date } = {}): Promise<MyPackageDetail> {
  if (!UUID_RE.test(grantId) || !UUID_RE.test(personId)) throw new NotFoundError("grant_not_found");
  const now = opts.now ?? new Date();
  const [head] = await db
    .select({ ...myPackageColumns(), ownerId: creditGrants.personId, sharing: creditGrants.sharing, ownerFirst: persons.firstName, ownerLast: persons.lastName })
    .from(vCreditGrantBalances)
    .innerJoin(creditGrants, eq(creditGrants.id, vCreditGrantBalances.grantId))
    .innerJoin(persons, eq(persons.id, creditGrants.personId))
    .leftJoin(products, eq(products.id, vCreditGrantBalances.productId))
    .where(eq(vCreditGrantBalances.grantId, grantId));
  if (!head) throw new NotFoundError("grant_not_found");
  const isOwner = head.ownerId === personId;
  if (!isOwner) {
    const [share] = await db
      .select({ id: packageShares.id })
      .from(packageShares)
      .where(and(eq(packageShares.grantId, grantId), eq(packageShares.sharedWithPersonId, personId), eq(packageShares.status, "active")));
    if (!share) throw new NotFoundError("grant_not_found");
  }
  const { ownerId, sharing, ownerFirst, ownerLast, ...card } = head;

  const released = sql<boolean>`exists (select 1 from credit_entries r where r.reverses_entry_id = ${creditEntries.id})`;
  const raw = await db
    .select({
      entryId: creditEntries.id,
      at: creditEntries.createdAt,
      kind: creditEntries.kind,
      quantity: creditEntries.quantity,
      refType: creditEntries.refType,
      refId: creditEntries.refId,
      data: creditEntries.data,
      beneficiaryPersonId: creditEntries.beneficiaryPersonId,
      beneficiaryFirst: persons.firstName,
      beneficiaryLast: persons.lastName,
      bookingStatus: bookings.status,
      sessionTitle: sessions.title,
      sessionStartsAt: sessions.startsAt,
      orderReference: orders.reference,
      isReleased: released,
    })
    .from(creditEntries)
    .leftJoin(persons, eq(persons.id, creditEntries.beneficiaryPersonId))
    .leftJoin(bookings, and(eq(creditEntries.refType, "booking"), eq(bookings.id, creditEntries.refId)))
    .leftJoin(sessions, eq(sessions.id, bookings.sessionId))
    .leftJoin(orders, and(eq(creditEntries.refType, "order"), eq(orders.id, creditEntries.refId)))
    .where(eq(creditEntries.grantId, grantId))
    .orderBy(desc(creditEntries.createdAt), desc(creditEntries.id));

  const visible = isOwner ? raw : raw.filter((e) => e.beneficiaryPersonId === personId);
  const usage: MyUsageRow[] = [];
  for (const e of visible) {
    const kind = USAGE_KIND[e.kind];
    if (!kind) continue;
    const isUse = e.kind === "consume" || e.kind === "release";
    const beneficiary = e.beneficiaryPersonId ?? (isUse ? ownerId : null);
    const newExpires = e.kind === "extend" ? (e.data as { new_expires_at?: string } | null)?.new_expires_at : undefined;
    usage.push({
      entryId: e.entryId,
      at: e.at,
      kind,
      quantity: e.quantity,
      sessionTitle: e.sessionTitle,
      sessionStartsAt: e.sessionStartsAt,
      usedBy: !isUse || !beneficiary ? null : beneficiary === personId ? { you: true } : { you: false, name: firstNameAndInitial(e.beneficiaryFirst, e.beneficiaryLast) },
      attendance: e.kind === "consume" ? (e.isReleased ? "cancelled" : attendanceOf(e.bookingStatus, e.sessionStartsAt, now)) : null,
      returned: e.kind === "consume" && Boolean(e.isReleased),
      newExpiresAt: newExpires ? new Date(newExpires) : null,
      orderReference: e.orderReference,
    });
  }

  let guestUsesLeft: number | null = null;
  if (isOwner && sharing.mode === "guests") {
    const month = brusselsMonthWindow(now);
    const refs = new Set(
      raw
        .filter((e) => e.kind === "consume" && !e.isReleased && e.beneficiaryPersonId && e.beneficiaryPersonId !== ownerId && e.at >= month.from && e.at < month.to)
        .map((e) => e.refId),
    );
    guestUsesLeft = Math.max(0, sharing.max_guest_uses_per_month - refs.size);
  }
  const orderUses =
    card.kind === "euro"
      ? raw
          .filter((e) => e.kind === "consume" && e.refType === "order" && e.refId && !e.isReleased)
          .map((e) => ({ orderId: e.refId!, reference: e.orderReference ?? "", at: e.at, amountCents: -e.quantity }))
      : [];
  return {
    package: toMyPackage(card),
    isOwner,
    upcoming: card.startsAt.getTime() > now.getTime(),
    ownerName: isOwner ? null : firstNameAndInitial(ownerFirst, ownerLast),
    sharingMode: sharing.mode,
    usage,
    guestUsesLeft,
    orders: orderUses,
  };
}

export type MyMembership = {
  membershipId: string;
  version: number;
  status: MembershipStatus;
  planName: LocalizedText;
  productId: string;
  interval: "month" | "year";
  memberSince: Date;
  currentPeriodStartAt: Date;
  currentPeriodEndAt: Date;
  cancelAt: Date | null;
  endedAt: Date | null;
  endReason: string | null;
  /** The next renewal date (period end) while the membership renews; null when it ends. */
  nextRenewalAt: Date | null;
  /** The open renewal order's total, else the last paid period's amount. */
  renewalAmountCents: number | null;
  paymentMethod: { method: string; summary: string | null; status: string } | null;
  discountPct: number;
  included: { grantId: string; kind: CreditKind; remainingUnits: number; baseUnits: number; expiresAt: Date | null }[];
  benefits: { benefitId: string; kind: string; text: LocalizedText }[];
  periods: { periodStartAt: Date; periodEndAt: Date; source: string; amountCents: number | null }[];
  /** `payMyRenewal` applies: `past_due`, or a link renewal with an open renewal order. */
  canPay: boolean;
  canCancel: boolean;
  canResume: boolean;
  /** A `pending` plan that starts after the current one (rule 57's "Change plan"). */
  upcoming: { membershipId: string; planName: LocalizedText; startsAt: Date } | null;
};

const LIVE_MEMBERSHIP: MembershipStatus[] = ["active", "past_due"];

/** `payMyRenewal` applies (spec section 4): `past_due`, or `active` paid by link, with an open renewal order. */
export function canPayRenewal(m: { status: MembershipStatus; renewalOrderStatus: string | null; hasValidMandate: boolean }): boolean {
  const open = m.renewalOrderStatus === "pending_payment" || m.renewalOrderStatus === "draft";
  return open && (m.status === "past_due" || (m.status === "active" && !m.hasValidMandate));
}

/**
 * `/[locale]/account/membership`: the reader's live membership (`active` or `past_due`), else
 * their `pending` one, else the last ended one (status shown, no actions); null when they never
 * had one. Includes this period's inclusion grants, the plan's active benefits, the history of
 * periods and the pending follow-up plan.
 */
export async function getMyMembership(db: DbOrTx, personId: string, opts: { now?: Date } = {}): Promise<MyMembership | null> {
  if (!UUID_RE.test(personId)) return null;
  const now = opts.now ?? new Date();
  const all = await db
    .select({ m: memberships, planName: products.name })
    .from(memberships)
    .innerJoin(products, eq(products.id, memberships.productId))
    .where(eq(memberships.personId, personId))
    .orderBy(desc(memberships.startedAt), desc(memberships.id));
  const chosen =
    all.find((r) => LIVE_MEMBERSHIP.includes(r.m.status)) ??
    all.find((r) => r.m.status === "pending") ??
    all.find((r) => r.m.status === "cancelled" || r.m.status === "expired");
  if (!chosen) return null;
  const m = chosen.m;
  const pending = LIVE_MEMBERSHIP.includes(m.status) ? all.find((r) => r.m.status === "pending") : undefined;

  const included = await db
    .select({
      grantId: vCreditGrantBalances.grantId,
      kind: vCreditGrantBalances.creditKind,
      remainingUnits: vCreditGrantBalances.remainingUnits,
      baseUnits: vCreditGrantBalances.baseUnits,
      expiresAt: vCreditGrantBalances.expiresAt,
    })
    .from(vCreditGrantBalances)
    .where(
      and(
        eq(vCreditGrantBalances.membershipId, m.id),
        sql`${vCreditGrantBalances.startsAt} >= ${m.currentPeriodStartAt.toISOString()}::timestamptz`,
        sql`${vCreditGrantBalances.startsAt} < ${m.currentPeriodEndAt.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(vCreditGrantBalances.creditKind));
  const benefits = await db
    .select({ benefitId: membershipPlanBenefits.id, kind: membershipPlanBenefits.kind, text: membershipPlanBenefits.text })
    .from(membershipPlanBenefits)
    .where(and(eq(membershipPlanBenefits.productId, m.productId), eq(membershipPlanBenefits.isActive, true)))
    .orderBy(asc(membershipPlanBenefits.sortOrder), asc(membershipPlanBenefits.id));
  const periods = await db
    .select({ periodStartAt: membershipPeriods.periodStartAt, periodEndAt: membershipPeriods.periodEndAt, source: membershipPeriods.source, amountCents: membershipPeriods.amountCents })
    .from(membershipPeriods)
    .where(eq(membershipPeriods.membershipId, m.id))
    .orderBy(desc(membershipPeriods.periodStartAt));
  const [renewal] = m.renewalOrderId
    ? await db.select({ status: orders.status, totalCents: orders.totalCents }).from(orders).where(eq(orders.id, m.renewalOrderId))
    : [];
  const [mandate] = m.mandateId
    ? await db.select({ method: mandates.method, summary: mandates.detailsSummary, status: mandates.status }).from(mandates).where(eq(mandates.id, m.mandateId))
    : [];
  const live = LIVE_MEMBERSHIP.includes(m.status);
  const renewalOpen = !!renewal && (renewal.status === "pending_payment" || renewal.status === "draft");
  const lastPaid = periods.find((p) => p.amountCents != null)?.amountCents ?? null;
  const started = all.filter((r) => r.m.status !== "pending").map((r) => r.m.startedAt);
  return {
    membershipId: m.id,
    version: m.version,
    status: m.status,
    planName: chosen.planName,
    productId: m.productId,
    interval: m.interval,
    memberSince: started.length ? new Date(Math.min(...started.map((d) => d.getTime()))) : m.startedAt,
    currentPeriodStartAt: m.currentPeriodStartAt,
    currentPeriodEndAt: m.currentPeriodEndAt,
    cancelAt: m.cancelAt,
    endedAt: m.endedAt,
    endReason: m.endReason,
    nextRenewalAt: live && !m.cancelAt ? m.currentPeriodEndAt : null,
    renewalAmountCents: renewalOpen ? renewal.totalCents : lastPaid,
    paymentMethod: mandate ? { method: mandate.method, summary: mandate.summary, status: mandate.status } : null,
    discountPct: Number(m.discountPct),
    included: included.map((g) => ({ ...g, remainingUnits: Number(g.remainingUnits), baseUnits: Number(g.baseUnits) })),
    benefits,
    periods,
    canPay: canPayRenewal({ status: m.status, renewalOrderStatus: renewal?.status ?? null, hasValidMandate: mandate?.status === "valid" }),
    canCancel: m.status === "pending" || m.status === "past_due" || (m.status === "active" && !m.cancelAt),
    canResume: m.status === "active" && !!m.cancelAt && m.cancelAt.getTime() > now.getTime(),
    upcoming: pending ? { membershipId: pending.m.id, planName: pending.planName, startsAt: pending.m.currentPeriodStartAt } : null,
  };
}

// ---------------------------------------------------------------------------
// Sharing (credits-P8, R2)
// ---------------------------------------------------------------------------

export type { MyShareRow, SharingReviewRow };

/** A `v_sharing_review` row with the names staff see (rule 38: full names) and the grant's label. */
export type SharingReviewItem = SharingReviewRow & {
  people: { personId: string; name: string }[];
  /** many_guests: the grant owner and the package name; guest_hopping: the guest. */
  subjectName: string;
  ownerPersonId: string | null;
  productName: LocalizedText | null;
  grantLabel: LocalizedText | null;
  sharingMode: "none" | "guests" | "named" | null;
};

/** `/admin/credits/sharing-review` (`credits.read`): the open review items with names. */
export async function listSharingReview(db: DbOrTx, opts: { limit?: number } = {}): Promise<SharingReviewItem[]> {
  const rows = await listReviewRows(db, { limit: opts.limit ?? 100 });
  const grantIds = rows.map((r) => r.grantId).filter((id): id is string => !!id);
  const grants = grantIds.length
    ? await db
        .select({ id: creditGrants.id, personId: creditGrants.personId, productName: products.name, label: creditGrants.label, sharing: creditGrants.sharing })
        .from(creditGrants)
        .leftJoin(products, eq(products.id, creditGrants.productId))
        .where(inArray(creditGrants.id, grantIds))
    : [];
  const byGrant = new Map(grants.map((g) => [g.id, g]));
  const ids = [...rows.flatMap((r) => r.personIds), ...rows.map((r) => r.guestPersonId).filter((id): id is string => !!id), ...grants.map((g) => g.personId)];
  const names = await personNames(db, ids);
  return rows.map((r) => {
    const g = r.grantId ? byGrant.get(r.grantId) : undefined;
    const subjectId = g?.personId ?? r.guestPersonId;
    return {
      ...r,
      people: r.personIds.map((personId) => ({ personId, name: names.get(personId) ?? "" })),
      subjectName: subjectId ? (names.get(subjectId) ?? "") : "",
      ownerPersonId: g?.personId ?? null,
      productName: g?.productName ?? null,
      grantLabel: g?.label ?? null,
      sharingMode: g?.sharing.mode ?? null,
    };
  });
}

/**
 * The portal sharing section (R2, `getMyShares`): the shares the reader gave on one of their own
 * grants (or on all of them), with what each sharee used, and whether another may be added
 * (mode `named`, active grant, fewer than 5 active shares, rule 41). A grant of someone else is
 * `not_found`.
 */
export async function getMyShares(
  db: DbOrTx,
  personId: string,
  opts: { grantId?: string } = {},
): Promise<{ shares: MyShareRow[]; canAdd: boolean; maxShares: number; activeCount: number }> {
  if (!UUID_RE.test(personId)) throw new NotFoundError("person_not_found");
  let canAdd = false;
  if (opts.grantId) {
    if (!UUID_RE.test(opts.grantId)) throw new NotFoundError("grant_not_found");
    const [g] = await db
      .select({ personId: creditGrants.personId, status: creditGrants.status, sharing: creditGrants.sharing, kind: creditGrants.creditKind, source: creditGrants.source })
      .from(creditGrants)
      .where(eq(creditGrants.id, opts.grantId));
    if (!g || g.personId !== personId) throw new NotFoundError("grant_not_found");
    canAdd = g.status === "active" && g.sharing.mode === "named" && g.kind !== "euro" && g.source !== "membership";
  }
  const shares = await getMySharesGiven(db, personId, opts);
  const activeCount = shares.filter((s) => s.status === "active").length;
  return { shares, canAdd: canAdd && activeCount < MAX_PORTAL_SHARES, maxShares: MAX_PORTAL_SHARES, activeCount };
}

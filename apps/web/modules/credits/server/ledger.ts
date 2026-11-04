/**
 * The credits ledger service (credits spec sections 2 and 3, rules 1 to 34; credits-P3). Every
 * write to `credit_entries` goes through `writeEntry()` inside a transaction that first locked the
 * grant row with `lockGrants()` (ascending id, rule 8). Balances are never stored: they are the
 * sum of the grant's entries, read under the lock (rule 7). Status follows the balance (rule 12,
 * `assertGrantTransition`). A duplicate idempotency key returns what exists and writes nothing
 * (rule 10). Reached only through `api.ts`, `jobs.ts` and (credits-P6) `actions.ts`.
 */
import type { DbOrTx } from "@beam/db";
import {
  creditEntries,
  creditGrants,
  memberships,
  orderLines,
  packageShares,
  products,
  vCreditGrantBalances,
  vPersonCredits,
  vPersonStatus,
  type CreditEntryRefType,
} from "@beam/db/schema";
import {
  allocateCredits,
  assertGrantTransition,
  brusselsDateOf,
  CREDITS_SETTINGS_DEFAULTS,
  crossedThresholds,
  defaultSharingFor,
  expireEntryKey,
  firesThresholds,
  GrantCreditsInputSchema,
  startOfDayIn,
  thresholdBase,
  thresholdDedupeKey,
  unitValueFor,
  vatTreatmentFor,
  type AllocationResult,
  type AllocGrant,
  type CreditKind,
  type CreditsSettings,
  type GrantSharing,
  type GrantStatus,
  type ReleaseReason,
} from "@beam/core/credits";
import type { LocalizedText } from "@beam/core/i18n";
import { actorJson, and, asc, ConflictError, eq, inArray, NotFoundError, sql, ValidationError, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";

// ---------------------------------------------------------------------------
// Errors (re-exported by api.ts)
// ---------------------------------------------------------------------------

export type InsufficientReason = "insufficient" | "guest_limit" | "not_shareable" | "share_limit";

/** Not enough eligible units (rule 16). Maps to `conflict` in `action()`. */
export class InsufficientCreditsError extends ConflictError {
  override readonly name: string = "InsufficientCreditsError";
  constructor(
    readonly kind: CreditKind,
    readonly needed: number,
    readonly available: number,
    readonly reason: InsufficientReason = "insufficient",
  ) {
    super(`insufficient_credits: ${reason}`);
  }
}

/** Units exist but the sharing rules exclude them (booking R55): `guest_limit`, `not_shareable`, `share_limit`. */
export class SharingNotAllowedError extends InsufficientCreditsError {
  override readonly name: string = "SharingNotAllowedError";
}

// ---------------------------------------------------------------------------
// Types and small helpers
// ---------------------------------------------------------------------------

export type GrantRow = typeof creditGrants.$inferSelect;
export type EntryRow = typeof creditEntries.$inferSelect;
export type EntryKind = EntryRow["kind"];

export type GrantCreditsInput = {
  personId: string;
  kind: CreditKind;
  units: number;
  source: "purchase" | "voucher" | "bonus" | "manual" | "import" | "referral";
  productId?: string;
  orderLineId?: string;
  lineUnitIndex?: number;
  voucherId?: string;
  refundId?: string;
  unitValueCents?: number;
  vatRatePct?: number | null;
  sharing?: GrantSharing;
  label?: LocalizedText;
  startsAt?: Date;
  expiresAt: Date | null;
  reason?: string;
  /** The full idempotency key, e.g. `grant:order_line:<id>:<n>`, `grant:voucher:<id>`. */
  key: string;
  data?: { original_units?: number; legacy_source?: string; legacy_id?: string; import_id?: string };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `credits` setting (its declared default when no row exists). */
export async function creditsSettings(db: DbOrTx): Promise<CreditsSettings> {
  try {
    return await getSetting(db, "credits");
  } catch {
    return structuredClone(CREDITS_SETTINGS_DEFAULTS) as unknown as CreditsSettings;
  }
}

/** The user id of a staff actor (stored in `created_by_user_id`), else null. */
function staffUserId(ctx: Ctx): string | null {
  return ctx.actor.kind === "staff" ? ctx.actor.userId : null;
}

/** 00:00 Brussels of the first day of the month of `at`, and of the next month. */
export function brusselsMonthWindow(at: Date): { from: Date; to: Date } {
  const d = brusselsDateOf(at);
  const next = d.month === 12 ? { year: d.year + 1, month: 1, day: 1 } : { year: d.year, month: d.month + 1, day: 1 };
  return { from: startOfDayIn({ year: d.year, month: d.month, day: 1 }), to: startOfDayIn(next) };
}

const isExpiredAt = (g: Pick<GrantRow, "expiresAt">, now: Date) => g.expiresAt !== null && g.expiresAt.getTime() <= now.getTime();

const grantRef = (grantId: string) => ({ type: "credit_grant", id: grantId });

// ---------------------------------------------------------------------------
// Locks, balances and the one entry writer
// ---------------------------------------------------------------------------

/**
 * Locks the grant rows `FOR UPDATE` in ascending id order (rule 8, edge case 3) and returns them
 * in that order. Unknown ids are simply absent from the result.
 */
export async function lockGrants(tx: DbOrTx, ids: readonly string[]): Promise<GrantRow[]> {
  const sorted = [...new Set(ids)].filter((id) => UUID_RE.test(id)).sort();
  if (sorted.length === 0) return [];
  return tx.select().from(creditGrants).where(inArray(creditGrants.id, sorted)).orderBy(asc(creditGrants.id)).for("update");
}

/** Locks one grant; `NotFoundError` when it does not exist. */
export async function lockGrant(tx: DbOrTx, id: string): Promise<GrantRow> {
  const [g] = await lockGrants(tx, [id]);
  if (!g) throw new NotFoundError("grant_not_found");
  return g;
}

/** Current balance per grant (sum of its entries). Call under the lock for a decision that writes. */
export async function balancesOf(tx: DbOrTx, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ grantId: creditEntries.grantId, sum: sql<number>`coalesce(sum(${creditEntries.quantity}), 0)::int` })
    .from(creditEntries)
    .where(inArray(creditEntries.grantId, [...ids]))
    .groupBy(creditEntries.grantId);
  for (const r of rows) out.set(r.grantId, Number(r.sum));
  return out;
}

export async function balanceOf(tx: DbOrTx, id: string): Promise<number> {
  return (await balancesOf(tx, [id])).get(id) ?? 0;
}

/** Net units used (`consume` plus `release`) of a grant. */
async function usedOf(tx: DbOrTx, id: string): Promise<number> {
  const [r] = await tx
    .select({ used: sql<number>`coalesce(-sum(${creditEntries.quantity}) filter (where ${creditEntries.kind} in ('consume', 'release')), 0)::int` })
    .from(creditEntries)
    .where(eq(creditEntries.grantId, id));
  return Number(r?.used ?? 0);
}

export async function entryByKey(tx: DbOrTx, key: string): Promise<EntryRow | undefined> {
  const [row] = await tx.select().from(creditEntries).where(eq(creditEntries.idempotencyKey, key));
  return row;
}

export type EntryInput = {
  grantId: string;
  /** The grant owner at write time. */
  personId: string;
  kind: EntryKind;
  quantity: number;
  beneficiaryPersonId?: string | null;
  reason?: string | null;
  refType?: CreditEntryRefType | null;
  refId?: string | null;
  reversesEntryId?: string | null;
  data?: Record<string, unknown>;
  key: string;
};

/**
 * Inserts one ledger entry with the context's actor. The caller holds the grant lock. A
 * duplicate `key` writes nothing and returns the existing row with `created: false` (rule 10).
 */
export async function writeEntry(tx: DbOrTx, ctx: Ctx, entry: EntryInput): Promise<{ entry: EntryRow; created: boolean }> {
  const [row] = await tx
    .insert(creditEntries)
    .values({
      grantId: entry.grantId,
      personId: entry.personId,
      beneficiaryPersonId: entry.beneficiaryPersonId ?? null,
      kind: entry.kind,
      quantity: entry.quantity,
      reason: entry.reason ?? null,
      refType: entry.refType ?? null,
      refId: entry.refId ?? null,
      reversesEntryId: entry.reversesEntryId ?? null,
      data: entry.data ?? {},
      actor: actorJson(ctx.actor),
      idempotencyKey: entry.key,
      createdAt: ctx.now,
    })
    .onConflictDoNothing({ target: creditEntries.idempotencyKey })
    .returning();
  if (row) return { entry: row, created: true };
  const existing = await entryByKey(tx, entry.key);
  if (!existing) throw new ConflictError(`entry_conflict: ${entry.key}`);
  return { entry: existing, created: false };
}

/** Moves a locked grant to `to` (checked against the status machine) and stamps `status_changed_at`. */
export async function setGrantStatus(tx: DbOrTx, ctx: Ctx, grant: GrantRow, to: GrantStatus): Promise<GrantRow> {
  if (grant.status === to) return grant;
  assertGrantTransition(grant.status, to);
  const [row] = await tx
    .update(creditGrants)
    .set({ status: to, statusChangedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(creditGrants.id, grant.id))
    .returning();
  return row!;
}

/**
 * Status after a balance change of a locked grant (rule 12): `active` at 0 becomes `exhausted`;
 * `exhausted` above 0 becomes `active` while not expired. A negative balance is refused (rule 9).
 */
async function followBalance(tx: DbOrTx, ctx: Ctx, grant: GrantRow, balance: number): Promise<GrantRow> {
  if (balance < 0) throw new InsufficientCreditsError(grant.creditKind, -balance, 0);
  if (grant.status === "active" && balance === 0) return setGrantStatus(tx, ctx, grant, "exhausted");
  if (grant.status === "exhausted" && balance > 0 && !isExpiredAt(grant, ctx.now)) return setGrantStatus(tx, ctx, grant, "active");
  return grant;
}

// ---------------------------------------------------------------------------
// Grants (rules 1 to 6, 20a)
// ---------------------------------------------------------------------------

/** A Zod failure as `ValidationError` with one message per field. */
function validationFrom(error: { issues: { path: PropertyKey[]; message: string }[] }): ValidationError {
  const fields: Record<string, string> = {};
  for (const i of error.issues) fields[String(i.path[0] ?? "_")] ??= i.message;
  return new ValidationError(`validation: ${Object.keys(fields).join(", ")}`, fields);
}

/** Serialises callers that use the same idempotency key inside their transactions. */
async function lockKey(tx: DbOrTx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * Creates a grant with its first `grant` entry (rule 3) in the caller's transaction: purchases
 * (one call per purchased unit, rule 1), voucher redemptions (euro, rule 1a), bonus, manual
 * (including the partial euro refund restore of rule 20a), import and referral grants. A second
 * call with the same `key` writes nothing and returns the existing grant (`created: false`).
 * Refuses (`validation`) a purchase grant on a `voucher` order line and an expiry that is not
 * after the start. Sharing defaults to the product's (rule 2); euro grants are never shared.
 */
export async function grantCredits(tx: DbOrTx, ctx: Ctx, raw: GrantCreditsInput): Promise<{ grantId: string; created: boolean }> {
  const parsed = GrantCreditsInputSchema.safeParse(raw);
  if (!parsed.success) throw validationFrom(parsed.error);
  const input = parsed.data;
  await lockKey(tx, input.key);
  const existing = await entryByKey(tx, input.key);
  if (existing) return { grantId: existing.grantId, created: false };

  let productId = input.productId ?? null;
  if (input.orderLineId) {
    const [line] = await tx
      .select({ productId: orderLines.productId, productKind: orderLines.productKind })
      .from(orderLines)
      .where(eq(orderLines.id, input.orderLineId));
    if (!line) throw new ValidationError("order_line_not_found", { orderLineId: "not_found" });
    if (input.source === "purchase" && line.productKind === "voucher") {
      throw new ValidationError("voucher_line_grants_nothing", { orderLineId: "voucher_line" });
    }
    productId ??= line.productId;
  }
  let product: { isSharingAllowed: boolean; maxGuestUsesPerMonth: number } | undefined;
  if (productId) {
    [product] = await tx
      .select({ isSharingAllowed: products.isSharingAllowed, maxGuestUsesPerMonth: products.maxGuestUsesPerMonth })
      .from(products)
      .where(eq(products.id, productId));
    if (!product) throw new ValidationError("product_not_found", { productId: "not_found" });
  }

  const startsAt = input.startsAt ?? ctx.now;
  if (input.expiresAt && input.expiresAt.getTime() <= startsAt.getTime()) {
    throw new ValidationError("expires_before_start", { expiresAt: "must be after startsAt" });
  }
  const sharing: GrantSharing =
    input.kind === "euro"
      ? { mode: "none", max_guest_uses_per_month: 0, allowed_person_ids: [] }
      : input.sharing
        ? { ...input.sharing, allowed_person_ids: [...input.sharing.allowed_person_ids] }
        : defaultSharingFor({
            kind: input.kind,
            source: input.source,
            isSharingAllowed: product?.isSharingAllowed,
            maxGuestUsesPerMonth: product?.maxGuestUsesPerMonth,
          });
  const data = { ...(input.data ?? {}), ...(input.refundId ? { refund_id: input.refundId } : {}) };

  const [inserted] = await tx
    .insert(creditGrants)
    .values({
      personId: input.personId,
      productId,
      orderLineId: input.orderLineId ?? null,
      lineUnitIndex: input.source === "purchase" ? (input.lineUnitIndex ?? null) : null,
      voucherId: input.voucherId ?? null,
      creditKind: input.kind,
      unitsGranted: input.units,
      unitValueCents: unitValueFor({ source: input.source, kind: input.kind, unitValueCents: input.unitValueCents }),
      vatRatePct: input.vatRatePct === undefined || input.vatRatePct === null ? null : input.vatRatePct.toFixed(2),
      vatTreatment: vatTreatmentFor({ source: input.source, kind: input.kind, refundId: input.refundId }),
      startsAt,
      expiresAt: input.expiresAt,
      validityRule: input.source === "import" ? "fixed" : "from_purchase",
      status: "active",
      statusChangedAt: ctx.now,
      source: input.source,
      sharing,
      label: input.label ?? null,
      data,
      createdByUserId: staffUserId(ctx),
    })
    .returning();
  const grant = inserted!;

  const ref: { refType: CreditEntryRefType | null; refId: string | null } = input.refundId
    ? { refType: "refund", refId: input.refundId }
    : input.source === "voucher"
      ? { refType: "voucher", refId: input.voucherId ?? null }
      : input.orderLineId
        ? { refType: "order_line", refId: input.orderLineId }
        : input.source === "import"
          ? { refType: "import", refId: input.data?.import_id ?? null }
          : { refType: null, refId: null };
  await writeEntry(tx, ctx, {
    grantId: grant.id,
    personId: input.personId,
    kind: "grant",
    quantity: input.units,
    reason: input.reason ?? null,
    ...ref,
    key: input.key,
  });
  await ctx.recordEvent({
    kind: "credits.granted",
    personId: input.personId,
    ref: grantRef(grant.id),
    dedupeKey: `grant:${grant.id}:granted`,
    data: { grant_id: grant.id, credit_kind: input.kind, units: input.units, source: input.source, product_id: productId },
  });
  return { grantId: grant.id, created: true };
}

/**
 * An opening balance from an `ops` import (rule 6): units = remaining legacy balance, base =
 * `originalUnits` when known, validity `fixed`, key `grant:<idempotencyKey>` (ops passes
 * `import:<import_id>:row:<row_number>`), so re-running an import changes nothing.
 */
export async function importGrant(
  tx: DbOrTx,
  ctx: Ctx,
  input: {
    personId: string;
    productId: string | null;
    creditKind: CreditKind;
    units: number;
    expiresAt: Date | null;
    idempotencyKey: string;
    originalUnits?: number;
    unitValueCents?: number;
    legacyId?: string;
  },
): Promise<{ grantId: string; created: boolean }> {
  const importId = /^import:([0-9a-f-]{36}):/i.exec(input.idempotencyKey)?.[1];
  const data: NonNullable<GrantCreditsInput["data"]> = {};
  if (input.originalUnits !== undefined && input.originalUnits > input.units) data.original_units = input.originalUnits;
  if (input.legacyId) data.legacy_id = input.legacyId;
  if (importId && UUID_RE.test(importId)) data.import_id = importId.toLowerCase();
  return grantCredits(tx, ctx, {
    personId: input.personId,
    kind: input.creditKind,
    units: input.units,
    source: "import",
    ...(input.productId ? { productId: input.productId } : {}),
    ...(input.creditKind === "euro" ? {} : { unitValueCents: input.unitValueCents ?? 0 }),
    expiresAt: input.expiresAt,
    key: `grant:${input.idempotencyKey}`,
    data,
  });
}

// ---------------------------------------------------------------------------
// Allocation input (rules 13 to 18)
// ---------------------------------------------------------------------------

type AllocContext = { payerPersonId: string; beneficiaryPersonId: string; kind: CreditKind; now: Date };

/**
 * The payer's active grants of `kind` plus (R2) grants named-shared with a beneficiary booking on
 * their own account, as `AllocGrant`s with balances, this Brussels month's guest uses (distinct
 * refs of unreleased guest consumes) and share usage. With `lock`, the grant rows are locked first
 * and every count is read under the lock (rule 17: two guest bookings cannot both take the last use).
 */
async function loadAllocGrants(tx: DbOrTx, c: AllocContext, lock: boolean): Promise<{ grants: GrantRow[]; alloc: AllocGrant[] }> {
  const own = await tx
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(and(eq(creditGrants.personId, c.payerPersonId), eq(creditGrants.creditKind, c.kind), eq(creditGrants.status, "active")));
  const shareRows =
    c.payerPersonId === c.beneficiaryPersonId
      ? await tx
          .select({ grantId: packageShares.grantId, maxUnits: packageShares.maxUnits })
          .from(packageShares)
          .where(and(eq(packageShares.sharedWithPersonId, c.payerPersonId), eq(packageShares.status, "active")))
      : [];
  const ids = [...own.map((r) => r.id), ...shareRows.map((r) => r.grantId)];
  const rows = lock
    ? await lockGrants(tx, ids)
    : ids.length
      ? await tx.select().from(creditGrants).where(inArray(creditGrants.id, ids)).orderBy(asc(creditGrants.id))
      : [];
  const grants = rows.filter((g) => g.status === "active" && g.creditKind === c.kind);
  if (grants.length === 0) return { grants, alloc: [] };
  const gids = grants.map((g) => g.id);
  const balances = await balancesOf(tx, gids);

  const month = brusselsMonthWindow(c.now);
  const guestRows = await tx
    .select({ grantId: creditEntries.grantId, n: sql<number>`count(distinct ${creditEntries.refId})::int` })
    .from(creditEntries)
    .where(
      and(
        inArray(creditEntries.grantId, gids),
        eq(creditEntries.kind, "consume"),
        sql`${creditEntries.beneficiaryPersonId} is not null and ${creditEntries.beneficiaryPersonId} <> ${creditEntries.personId}`,
        sql`${creditEntries.createdAt} >= ${month.from.toISOString()}::timestamptz and ${creditEntries.createdAt} < ${month.to.toISOString()}::timestamptz`,
        sql`not exists (select 1 from credit_entries r where r.reverses_entry_id = credit_entries.id)`,
      ),
    )
    .groupBy(creditEntries.grantId);
  const guestUses = new Map(guestRows.map((r) => [r.grantId, Number(r.n)]));

  const sharedIds = shareRows.map((s) => s.grantId);
  const usedByMe = new Map<string, number>();
  if (sharedIds.length) {
    const used = await tx
      .select({ grantId: creditEntries.grantId, used: sql<number>`coalesce(-sum(${creditEntries.quantity}), 0)::int` })
      .from(creditEntries)
      .where(
        and(
          inArray(creditEntries.grantId, sharedIds),
          inArray(creditEntries.kind, ["consume", "release"]),
          eq(creditEntries.beneficiaryPersonId, c.payerPersonId),
        ),
      )
      .groupBy(creditEntries.grantId);
    for (const u of used) usedByMe.set(u.grantId, Number(u.used));
  }

  const alloc = grants.map((g): AllocGrant => {
    const share = g.personId !== c.payerPersonId ? shareRows.find((s) => s.grantId === g.id) : undefined;
    return {
      id: g.id,
      ownerPersonId: g.personId,
      kind: g.creditKind,
      status: g.status,
      startsAt: g.startsAt,
      expiresAt: g.expiresAt,
      remaining: balances.get(g.id) ?? 0,
      sharing: g.sharing,
      guestUsesThisMonth: guestUses.get(g.id) ?? 0,
      ...(share ? { share: { maxUnits: share.maxUnits, usedByBeneficiary: usedByMe.get(g.id) ?? 0 } } : {}),
    };
  });
  return { grants, alloc };
}

/** The error of a failed allocation (rule 16): `insufficient`, or the sharing reason. */
function allocationError(kind: CreditKind, needed: number, r: Extract<AllocationResult, { ok: false }>): InsufficientCreditsError {
  return r.reason === "insufficient"
    ? new InsufficientCreditsError(kind, needed, r.available, "insufficient")
    : new SharingNotAllowedError(kind, needed, r.available, r.reason);
}

type ConsumeInput = {
  personId: string;
  beneficiaryPersonId: string;
  kind: CreditKind;
  units: number;
  ref: { type: "booking" | "order"; id: string };
  validAt?: Date;
};

function checkConsumeInput(input: ConsumeInput): void {
  if (!Number.isInteger(input.units) || input.units <= 0) throw new ValidationError("invalid_units", { units: "positive integer" });
  if (!UUID_RE.test(input.ref.id)) throw new ValidationError("invalid_ref", { ref: "uuid" });
  if (input.kind === "euro") {
    if (input.ref.type !== "order") throw new ValidationError("euro_needs_order", { ref: "euro is spent on an order" });
    if (input.personId !== input.beneficiaryPersonId) throw new ValidationError("euro_payer_is_beneficiary", { beneficiaryPersonId: "must be the buyer" });
  } else if (input.ref.type !== "booking") {
    throw new ValidationError("units_need_booking", { ref: "day and night units pay bookings" });
  }
}

/** Remaining units of the payer's own grants usable at `validAt`. */
function ownRemaining(alloc: readonly AllocGrant[], payer: string, validAt: Date, taken: Map<string, number>): number {
  const t = validAt.getTime();
  return alloc
    .filter((g) => g.ownerPersonId === payer && g.startsAt.getTime() <= t && (g.expiresAt === null || t < g.expiresAt.getTime()))
    .reduce((n, g) => n + g.remaining - (taken.get(g.id) ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Consume, release, check (rules 13 to 26)
// ---------------------------------------------------------------------------

/**
 * Pays a booking (day, night; `validAt` = session start) or an order (euro; `validAt` = now) from
 * the payer's grants (rules 13 to 20): locks the candidate grants, allocates in memory, writes one
 * `consume` per grant used (`consume:<booking_id>:<grant_id>`, `consume:order:<order_id>:<grant_id>`),
 * moves a grant that reaches 0 to `exhausted`, records `credits.consumed` (owner) and
 * `credits.guest_used` (beneficiary), and the threshold events of rules 21 to 23. A ref that was
 * already paid returns its entries and writes nothing.
 */
export async function consumeCredits(
  tx: DbOrTx,
  ctx: Ctx,
  input: ConsumeInput,
): Promise<{ entries: { entryId: string; grantId: string; quantity: number }[]; remainingUnits: number }> {
  checkConsumeInput(input);
  const validAt = input.validAt ?? ctx.now;
  const c: AllocContext = { payerPersonId: input.personId, beneficiaryPersonId: input.beneficiaryPersonId, kind: input.kind, now: ctx.now };
  const { grants, alloc } = await loadAllocGrants(tx, c, true);

  // Under the locks: a retried booking or order returns what it already consumed.
  const prior = await tx
    .select()
    .from(creditEntries)
    .where(and(eq(creditEntries.kind, "consume"), eq(creditEntries.refType, input.ref.type), eq(creditEntries.refId, input.ref.id)));
  if (prior.length) {
    const released = await tx
      .select({ id: creditEntries.reversesEntryId })
      .from(creditEntries)
      .where(and(eq(creditEntries.kind, "release"), inArray(creditEntries.reversesEntryId, prior.map((p) => p.id))));
    const releasedIds = new Set(released.map((r) => r.id));
    const live = prior.filter((p) => !releasedIds.has(p.id));
    if (live.length === 0) throw new ConflictError("ref_already_released");
    return {
      entries: live.map((e) => ({ entryId: e.id, grantId: e.grantId, quantity: e.quantity })),
      remainingUnits: ownRemaining(alloc, input.personId, validAt, new Map()),
    };
  }

  const result = allocateCredits(alloc, input.kind, input.units, { payerPersonId: input.personId, beneficiaryPersonId: input.beneficiaryPersonId, validAt });
  if (!result.ok) throw allocationError(input.kind, input.units, result);

  const settings = await creditsSettings(tx);
  const taken = new Map<string, number>();
  const entries: { entryId: string; grantId: string; quantity: number }[] = [];
  for (const part of result.parts) {
    const grant = grants.find((g) => g.id === part.grantId)!;
    const before = alloc.find((g) => g.id === part.grantId)!.remaining;
    const usedBefore = await usedOf(tx, grant.id);
    const key = input.ref.type === "booking" ? `consume:${input.ref.id}:${grant.id}` : `consume:order:${input.ref.id}:${grant.id}`;
    const { entry, created } = await writeEntry(tx, ctx, {
      grantId: grant.id,
      personId: grant.personId,
      beneficiaryPersonId: input.beneficiaryPersonId,
      kind: "consume",
      quantity: -part.units,
      refType: input.ref.type,
      refId: input.ref.id,
      data: input.kind === "euro" ? { vat_at_redemption: true } : {},
      key,
    });
    entries.push({ entryId: entry.id, grantId: grant.id, quantity: entry.quantity });
    if (!created) continue;
    taken.set(grant.id, part.units);
    const after = before - part.units;
    await followBalance(tx, ctx, grant, after);

    await ctx.recordEvent({
      kind: "credits.consumed",
      personId: grant.personId,
      ref: grantRef(grant.id),
      dedupeKey: `grant:${grant.id}:consumed:${entry.id}`,
      data: {
        grant_id: grant.id,
        credit_kind: grant.creditKind,
        units: part.units,
        ref_type: input.ref.type,
        ref_id: input.ref.id,
        beneficiary_person_id: input.beneficiaryPersonId,
        remaining_units: after,
      },
    });
    if (input.beneficiaryPersonId !== grant.personId) {
      await ctx.recordEvent({
        kind: "credits.guest_used",
        personId: input.beneficiaryPersonId,
        ref: grantRef(grant.id),
        dedupeKey: `grant:${grant.id}:guest_used:${entry.id}`,
        data: { grant_id: grant.id, credit_kind: grant.creditKind, units: part.units, owner_person_id: grant.personId, ref_type: input.ref.type, ref_id: input.ref.id },
      });
    }
    if (firesThresholds(grant.source)) {
      const { base, usedOffset } = thresholdBase({ unitsGranted: grant.unitsGranted, originalUnits: grant.data.original_units ?? null });
      const hits = crossedThresholds({
        base,
        usedBefore: usedBefore + usedOffset,
        usedAfter: usedBefore + usedOffset + part.units,
        remainingAfter: after,
        pcts: [...settings.threshold_pcts],
      });
      for (const hit of hits) {
        await ctx.recordEvent(
          hit === "exhausted"
            ? {
                kind: "credits.grant_exhausted",
                personId: grant.personId,
                ref: grantRef(grant.id),
                dedupeKey: thresholdDedupeKey(grant.id, hit),
                data: { grant_id: grant.id, credit_kind: grant.creditKind, source: grant.source, product_id: grant.productId },
              }
            : {
                kind: "credits.threshold_reached",
                personId: grant.personId,
                ref: grantRef(grant.id),
                dedupeKey: thresholdDedupeKey(grant.id, hit),
                data: { grant_id: grant.id, credit_kind: grant.creditKind, pct: hit, remaining_units: after },
              },
        );
      }
    }
  }
  return { entries, remainingUnits: ownRemaining(alloc, input.personId, validAt, taken) };
}

/**
 * Gives back every unreleased `consume` of a booking or an order (rules 20, 24 to 26): one
 * `release` per consume (`release:<consume_id>`, `data.reason`), to the original grant. A grant
 * that comes back above 0 before its expiry becomes `active` again; a grant that is already
 * expired (or exhausted past its expiry) gets an immediate `expire` of the released amount
 * (`expire:<grant_id>:after_release:<release_id>`, rule 26). Calling it twice releases nothing more.
 * A release onto a `revoked` grant (refunded package) is revoked again at once
 * (`revoke:after_release:<release_id>`), so a refunded package never regains units.
 */
export async function releaseCredits(
  tx: DbOrTx,
  ctx: Ctx,
  input: { ref: { type: "booking" | "order"; id: string }; reason: ReleaseReason },
): Promise<{ releasedUnits: number }> {
  if (!UUID_RE.test(input.ref.id)) throw new ValidationError("invalid_ref", { ref: "uuid" });
  const where = and(eq(creditEntries.kind, "consume"), eq(creditEntries.refType, input.ref.type), eq(creditEntries.refId, input.ref.id));
  const first = await tx.select({ grantId: creditEntries.grantId }).from(creditEntries).where(where);
  if (first.length === 0) return { releasedUnits: 0 };
  const locked = new Map((await lockGrants(tx, first.map((r) => r.grantId))).map((g) => [g.id, g]));
  const consumes = await tx.select().from(creditEntries).where(where).orderBy(asc(creditEntries.grantId), asc(creditEntries.createdAt));
  const released = await tx
    .select({ id: creditEntries.reversesEntryId })
    .from(creditEntries)
    .where(and(eq(creditEntries.kind, "release"), inArray(creditEntries.reversesEntryId, consumes.map((c) => c.id))));
  const releasedIds = new Set(released.map((r) => r.id));

  let releasedUnits = 0;
  for (const c of consumes) {
    if (releasedIds.has(c.id)) continue;
    let grant = locked.get(c.grantId)!;
    const units = -c.quantity;
    const { entry: rel, created } = await writeEntry(tx, ctx, {
      grantId: grant.id,
      personId: grant.personId,
      beneficiaryPersonId: c.beneficiaryPersonId,
      kind: "release",
      quantity: units,
      refType: c.refType,
      refId: c.refId,
      reversesEntryId: c.id,
      data: { reason: input.reason },
      key: `release:${c.id}`,
    });
    if (!created) continue;
    releasedUnits += units;
    if (grant.status === "revoked") {
      await writeEntry(tx, ctx, {
        grantId: grant.id,
        personId: grant.personId,
        kind: "revoke",
        quantity: -units,
        reason: "released to a revoked grant",
        refType: c.refType,
        refId: c.refId,
        key: `revoke:after_release:${rel.id}`,
      });
    } else if (grant.status === "expired" || (grant.status === "exhausted" && isExpiredAt(grant, ctx.now))) {
      await writeEntry(tx, ctx, {
        grantId: grant.id,
        personId: grant.personId,
        kind: "expire",
        quantity: -units,
        refType: c.refType,
        refId: c.refId,
        key: `expire:${grant.id}:after_release:${rel.id}`,
      });
      grant = await setGrantStatus(tx, ctx, grant, "expired");
    } else {
      grant = await followBalance(tx, ctx, grant, await balanceOf(tx, grant.id));
    }
    locked.set(grant.id, grant);
    await ctx.recordEvent({
      kind: "credits.released",
      personId: grant.personId,
      ref: grantRef(grant.id),
      dedupeKey: `grant:${grant.id}:released:${rel.id}`,
      data: { grant_id: grant.id, credit_kind: grant.creditKind, units, reason: input.reason, ref_type: input.ref.type, ref_id: input.ref.id },
    });
  }
  return { releasedUnits };
}

/** The allocation a consume would make now, without locks or writes (UI pre-checks, edge case 17). */
export async function checkCredits(
  db: DbOrTx,
  input: { personId: string; beneficiaryPersonId: string; kind: CreditKind; units: number; validAt: Date },
): Promise<AllocationResult> {
  if (!Number.isInteger(input.units) || input.units <= 0) throw new ValidationError("invalid_units", { units: "positive integer" });
  const { alloc } = await loadAllocGrants(db, { payerPersonId: input.personId, beneficiaryPersonId: input.beneficiaryPersonId, kind: input.kind, now: new Date() }, false);
  return allocateCredits(alloc, input.kind, input.units, { payerPersonId: input.personId, beneficiaryPersonId: input.beneficiaryPersonId, validAt: input.validAt });
}

// ---------------------------------------------------------------------------
// Revocation (rules 27, 28)
// ---------------------------------------------------------------------------

function checkReason(reason: string): string {
  const r = reason.trim();
  if (r.length < 3 || r.length > 500) throw new ValidationError("invalid_reason", { reason: "3 to 500 characters" });
  return r;
}

async function revokeLocked(
  tx: DbOrTx,
  ctx: Ctx,
  grant: GrantRow,
  e: { key: string; reason: string; refType?: CreditEntryRefType | null; refId?: string | null },
): Promise<number> {
  const balance = await balanceOf(tx, grant.id);
  if (balance <= 0) return 0;
  await writeEntry(tx, ctx, { grantId: grant.id, personId: grant.personId, kind: "revoke", quantity: -balance, reason: e.reason, refType: e.refType, refId: e.refId, key: e.key });
  await setGrantStatus(tx, ctx, grant, "revoked");
  await ctx.recordEvent({
    kind: "credits.revoked",
    personId: grant.personId,
    ref: grantRef(grant.id),
    dedupeKey: `grant:${grant.id}:revoked`,
    data: { grant_id: grant.id, credit_kind: grant.creditKind, units: balance },
  });
  return balance;
}

/**
 * Package refund (rule 27): revokes the remaining units of the named grants of an order line
 * (default: every non-revoked grant of the line), key `revoke:order_line:<order_line_id>:<grant_id>`,
 * `ref_type = 'refund'` when `refundId` is given. Used units are never revoked; `exhausted`,
 * `expired` and `revoked` grants are skipped. A replay returns the same counts and writes nothing.
 */
export async function revokeGrantRemainder(
  tx: DbOrTx,
  ctx: Ctx,
  input: { orderLineId: string; grantIds?: string[]; refundId?: string; reason: string },
): Promise<{ revokedUnits: number; grants: { grantId: string; revokedUnits: number }[] }> {
  if (!UUID_RE.test(input.orderLineId)) throw new ValidationError("invalid_order_line", { orderLineId: "uuid" });
  const reason = input.reason.trim() || "refund";
  const onLine = await tx
    .select({ id: creditGrants.id, status: creditGrants.status })
    .from(creditGrants)
    .where(eq(creditGrants.orderLineId, input.orderLineId))
    .orderBy(asc(creditGrants.lineUnitIndex), asc(creditGrants.id));
  if (input.grantIds) {
    const known = new Set(onLine.map((g) => g.id));
    const foreign = input.grantIds.filter((id) => !known.has(id));
    if (foreign.length) throw new ValidationError("grant_not_on_line", { grantIds: foreign.join(",") });
  }
  const targets = input.grantIds ?? onLine.map((g) => g.id);
  const locked = await lockGrants(tx, targets);
  const out: { grantId: string; revokedUnits: number }[] = [];
  for (const grant of locked) {
    const key = `revoke:order_line:${input.orderLineId}:${grant.id}`;
    const prior = await entryByKey(tx, key);
    if (prior) {
      out.push({ grantId: grant.id, revokedUnits: -prior.quantity });
      continue;
    }
    if (grant.status !== "active") {
      out.push({ grantId: grant.id, revokedUnits: 0 });
      continue;
    }
    const units = await revokeLocked(tx, ctx, grant, {
      key,
      reason,
      refType: input.refundId ? "refund" : "order_line",
      refId: input.refundId ?? input.orderLineId,
    });
    out.push({ grantId: grant.id, revokedUnits: units });
  }
  return { revokedUnits: out.reduce((n, g) => n + g.revokedUnits, 0), grants: out };
}

/** Staff revoke (rule 28, `credits.adjust`): all remaining units, key `revoke:<client_key>`; audit `credits.grant_revoked`. */
export async function revoke(
  tx: DbOrTx,
  ctx: Ctx,
  input: { grantId: string; reason: string; clientKey: string },
): Promise<{ revokedUnits: number; created: boolean }> {
  const reason = checkReason(input.reason);
  const grant = await lockGrant(tx, input.grantId);
  const key = `revoke:${input.clientKey}`;
  const prior = await entryByKey(tx, key);
  if (prior) return { revokedUnits: -prior.quantity, created: false };
  if (grant.status !== "active") throw new ConflictError(`grant_${grant.status}`);
  const units = await revokeLocked(tx, ctx, grant, { key, reason });
  if (units === 0) throw new ConflictError("nothing_to_revoke");
  await ctx.audit({
    action: "credits.grant_revoked",
    entityType: "credit_grant",
    entityId: grant.id,
    personId: grant.personId,
    oldValue: { status: grant.status, balance: units },
    newValue: { status: "revoked", balance: 0 },
  });
  return { revokedUnits: units, created: true };
}

// ---------------------------------------------------------------------------
// Adjustments, extensions, transfers (rules 31 to 34)
// ---------------------------------------------------------------------------

/**
 * Staff adjustment (rule 33): `adjust` of a non-zero quantity, key `adjust:<client_key>`; a
 * negative adjustment cannot exceed the balance. Refused on `revoked` and `expired` grants
 * (extend an expired grant instead). Audit `credits.adjusted` with the old and new balance.
 */
export async function adjust(
  tx: DbOrTx,
  ctx: Ctx,
  input: { grantId: string; quantity: number; reason: string; clientKey: string },
): Promise<{ oldBalance: number; newBalance: number; created: boolean }> {
  if (!Number.isInteger(input.quantity) || input.quantity === 0) throw new ValidationError("invalid_quantity", { quantity: "non-zero integer" });
  const reason = checkReason(input.reason);
  let grant = await lockGrant(tx, input.grantId);
  const key = `adjust:${input.clientKey}`;
  const oldBalance = await balanceOf(tx, grant.id);
  if (await entryByKey(tx, key)) return { oldBalance, newBalance: oldBalance, created: false };
  if (grant.status === "revoked" || grant.status === "expired") throw new ConflictError(`grant_${grant.status}`);
  if (input.quantity > 0 && isExpiredAt(grant, ctx.now)) throw new ConflictError("grant_expired");
  const newBalance = oldBalance + input.quantity;
  if (newBalance < 0) throw new InsufficientCreditsError(grant.creditKind, -input.quantity, oldBalance);
  await writeEntry(tx, ctx, { grantId: grant.id, personId: grant.personId, kind: "adjust", quantity: input.quantity, reason, key });
  grant = await followBalance(tx, ctx, grant, newBalance);
  await ctx.recordEvent({
    kind: "credits.adjusted",
    personId: grant.personId,
    ref: grantRef(grant.id),
    dedupeKey: `grant:${grant.id}:adjusted:${input.clientKey}`,
    data: { grant_id: grant.id, credit_kind: grant.creditKind, quantity: input.quantity, remaining_units: newBalance },
  });
  await ctx.audit({
    action: "credits.adjusted",
    entityType: "credit_grant",
    entityId: grant.id,
    personId: grant.personId,
    oldValue: { balance: oldBalance },
    newValue: { balance: newBalance, quantity: input.quantity },
  });
  return { oldBalance, newBalance, created: true };
}

/**
 * Extension (rules 31, 32, 32a): writes `extend` (quantity 0, old and new expiry) and moves
 * `expires_at`. The new date must be later than the old one and at most `max_extension_years`
 * after now. An `expired` grant whose expiry is at most `reinstate_window_days` old is reinstated
 * (`adjust` of the expired units, reason `reinstated on extension`, status `active`); older ones
 * and `revoked` grants are refused (`conflict`). With `bulkExtensionId` (job `credits.bulk_extend`)
 * the key is `extend:bulk:<bulk_extension_id>:<grant_id>`, expired grants are refused, the reason
 * goes to `data.reason` and no per-grant audit row is written; otherwise `extend:<client_key>` and
 * audit `credits.grant_extended`.
 */
export async function extend(
  tx: DbOrTx,
  ctx: Ctx,
  input: { grantId: string; newExpiresAt: Date; reason: string; clientKey?: string; bulkExtensionId?: string },
): Promise<{ created: boolean; oldExpiresAt: Date | null; newExpiresAt: Date | null; reinstatedUnits: number }> {
  const reason = checkReason(input.reason);
  if (!input.clientKey && !input.bulkExtensionId) throw new ValidationError("missing_client_key", { clientKey: "required" });
  let grant = await lockGrant(tx, input.grantId);
  const key = input.bulkExtensionId ? `extend:bulk:${input.bulkExtensionId}:${grant.id}` : `extend:${input.clientKey}`;
  if (await entryByKey(tx, key)) return { created: false, oldExpiresAt: grant.expiresAt, newExpiresAt: grant.expiresAt, reinstatedUnits: 0 };
  if (grant.status === "revoked") throw new ConflictError("grant_revoked");
  if (grant.status === "expired" && input.bulkExtensionId) throw new ConflictError("grant_expired");
  const old = grant.expiresAt;
  if (old === null) throw new ValidationError("grant_never_expires", { newExpiresAt: "the grant has no expiry" });
  if (input.newExpiresAt.getTime() <= old.getTime()) throw new ValidationError("not_later", { newExpiresAt: "must be later than the current expiry" });
  const settings = await creditsSettings(tx);
  const limit = new Date(ctx.now);
  limit.setUTCFullYear(limit.getUTCFullYear() + settings.max_extension_years);
  if (input.newExpiresAt.getTime() > limit.getTime()) throw new ValidationError("too_far", { newExpiresAt: `at most ${settings.max_extension_years} years ahead` });

  let reinstate = 0;
  if (grant.status === "expired") {
    if (input.newExpiresAt.getTime() <= ctx.now.getTime()) throw new ValidationError("not_in_future", { newExpiresAt: "must be in the future" });
    const [lastExtend] = await tx
      .select({ at: sql<Date | null>`max(${creditEntries.createdAt})` })
      .from(creditEntries)
      .where(and(eq(creditEntries.grantId, grant.id), eq(creditEntries.kind, "extend")));
    const since = lastExtend?.at ? new Date(lastExtend.at) : null;
    const [exp] = await tx
      .select({ units: sql<number>`coalesce(-sum(${creditEntries.quantity}), 0)::int`, lastAt: sql<Date | null>`max(${creditEntries.createdAt})` })
      .from(creditEntries)
      .where(
        and(
          eq(creditEntries.grantId, grant.id),
          eq(creditEntries.kind, "expire"),
          since ? sql`${creditEntries.createdAt} > ${since.toISOString()}::timestamptz` : sql`true`,
        ),
      );
    const lastAt = exp?.lastAt ? new Date(exp.lastAt) : grant.statusChangedAt;
    if (ctx.now.getTime() - lastAt.getTime() > settings.reinstate_window_days * 86_400_000) throw new ConflictError("reinstate_window_passed");
    reinstate = Number(exp?.units ?? 0);
    if (reinstate <= 0) throw new ConflictError("nothing_to_reinstate");
  }

  await writeEntry(tx, ctx, {
    grantId: grant.id,
    personId: grant.personId,
    kind: "extend",
    quantity: 0,
    reason: input.bulkExtensionId ? null : reason,
    refType: input.bulkExtensionId ? "bulk_extension" : null,
    refId: input.bulkExtensionId ?? null,
    data: { old_expires_at: old.toISOString(), new_expires_at: input.newExpiresAt.toISOString(), ...(input.bulkExtensionId ? { reason } : {}) },
    key,
  });
  const [updated] = await tx
    .update(creditGrants)
    .set({
      expiresAt: input.newExpiresAt,
      updatedAt: ctx.now,
      ...(input.bulkExtensionId ? { data: { ...grant.data, last_bulk_extension_id: input.bulkExtensionId } } : {}),
    })
    .where(eq(creditGrants.id, grant.id))
    .returning();
  grant = updated!;
  if (reinstate > 0) {
    await writeEntry(tx, ctx, { grantId: grant.id, personId: grant.personId, kind: "adjust", quantity: reinstate, reason: "reinstated on extension", key: `${key}:reinstate` });
    grant = await setGrantStatus(tx, ctx, grant, "active");
  }
  await ctx.recordEvent({
    kind: "credits.extended",
    personId: grant.personId,
    ref: grantRef(grant.id),
    dedupeKey: `grant:${grant.id}:extended:${key}`,
    data: {
      grant_id: grant.id,
      credit_kind: grant.creditKind,
      old_expires_at: old.toISOString(),
      new_expires_at: input.newExpiresAt.toISOString(),
      reinstated_units: reinstate,
    },
  });
  if (!input.bulkExtensionId) {
    await ctx.audit({
      action: "credits.grant_extended",
      entityType: "credit_grant",
      entityId: grant.id,
      personId: grant.personId,
      oldValue: { expires_at: old.toISOString(), status: reinstate > 0 ? "expired" : grant.status },
      newValue: { expires_at: input.newExpiresAt.toISOString(), status: grant.status, reinstated_units: reinstate },
    });
  }
  return { created: true, oldExpiresAt: old, newExpiresAt: input.newExpiresAt, reinstatedUnits: reinstate };
}

/**
 * Transfer (rule 34, `credits.adjust`): `transfer_out` of `units` on the source and a new grant
 * of the recipient (source `transfer`, same kind, expiry, unit value and VAT treatment,
 * `data.transfer_from_grant_id`) with its `transfer_in`, in one transaction; keys
 * `transfer:<client_key>:out` and `:in`; one audit row `credits.transferred`.
 */
export async function transfer(
  tx: DbOrTx,
  ctx: Ctx,
  input: { grantId: string; toPersonId: string; units: number; reason: string; clientKey: string },
): Promise<{ toGrantId: string; created: boolean }> {
  if (!Number.isInteger(input.units) || input.units <= 0) throw new ValidationError("invalid_units", { units: "positive integer" });
  const reason = checkReason(input.reason);
  let source = await lockGrant(tx, input.grantId);
  const outKey = `transfer:${input.clientKey}:out`;
  const inKey = `transfer:${input.clientKey}:in`;
  if (await entryByKey(tx, outKey)) {
    const inEntry = await entryByKey(tx, inKey);
    return { toGrantId: inEntry!.grantId, created: false };
  }
  if (input.toPersonId === source.personId) throw new ValidationError("same_person", { toPersonId: "already owns the grant" });
  if (source.status !== "active" || isExpiredAt(source, ctx.now)) throw new ConflictError(`grant_${source.status === "active" ? "expired" : source.status}`);
  const balance = await balanceOf(tx, source.id);
  if (balance < input.units) throw new InsufficientCreditsError(source.creditKind, input.units, balance);

  const [target] = await tx
    .insert(creditGrants)
    .values({
      personId: input.toPersonId,
      productId: source.productId,
      creditKind: source.creditKind,
      unitsGranted: input.units,
      unitValueCents: source.unitValueCents,
      vatRatePct: source.vatRatePct,
      vatTreatment: vatTreatmentFor({ source: "transfer", kind: source.creditKind, transferFromTreatment: source.vatTreatment }),
      startsAt: source.startsAt.getTime() > ctx.now.getTime() ? source.startsAt : ctx.now,
      expiresAt: source.expiresAt,
      validityRule: source.validityRule,
      status: "active",
      statusChangedAt: ctx.now,
      source: "transfer",
      sharing: { ...source.sharing, allowed_person_ids: [] },
      label: source.label,
      data: { transfer_from_grant_id: source.id },
      createdByUserId: staffUserId(ctx),
    })
    .returning();
  await writeEntry(tx, ctx, { grantId: source.id, personId: source.personId, kind: "transfer_out", quantity: -input.units, reason, refType: "transfer", refId: target!.id, key: outKey });
  await writeEntry(tx, ctx, { grantId: target!.id, personId: input.toPersonId, kind: "transfer_in", quantity: input.units, reason, refType: "transfer", refId: source.id, key: inKey });
  source = await followBalance(tx, ctx, source, balance - input.units);
  await ctx.recordEvent({
    kind: "credits.transferred_out",
    personId: source.personId,
    ref: grantRef(source.id),
    dedupeKey: `grant:${source.id}:transferred_out:${input.clientKey}`,
    data: { grant_id: source.id, credit_kind: source.creditKind, units: input.units, to_grant_id: target!.id },
  });
  await ctx.recordEvent({
    kind: "credits.transferred_in",
    personId: input.toPersonId,
    ref: grantRef(target!.id),
    dedupeKey: `grant:${target!.id}:transferred_in`,
    data: { grant_id: target!.id, credit_kind: source.creditKind, units: input.units, from_grant_id: source.id },
  });
  await ctx.audit({
    action: "credits.transferred",
    entityType: "credit_grant",
    entityId: source.id,
    personId: source.personId,
    oldValue: { balance },
    newValue: { balance: balance - input.units, units: input.units, to_grant_id: target!.id, to_person_id: input.toPersonId },
  });
  return { toGrantId: target!.id, created: true };
}

// ---------------------------------------------------------------------------
// Expiry (rules 29, 30)
// ---------------------------------------------------------------------------

/**
 * Expires one grant (job `credits.expire_grant`): under the lock, an `active` grant whose
 * `expires_at` has passed gets `expire` of its balance (key `expire:<grant_id>:<expires_at date>`)
 * and status `expired`; a balance of 0 (status drift) changes the status without an entry.
 * Anything else (already expired, extended meanwhile, revoked) is a no-op.
 */
export async function expireGrant(tx: DbOrTx, ctx: Ctx, grantId: string): Promise<{ expired: boolean; units: number }> {
  const [grant] = await lockGrants(tx, [grantId]);
  if (!grant || grant.status !== "active" || !grant.expiresAt || grant.expiresAt.getTime() > ctx.now.getTime()) return { expired: false, units: 0 };
  const balance = await balanceOf(tx, grant.id);
  if (balance > 0) {
    await writeEntry(tx, ctx, { grantId: grant.id, personId: grant.personId, kind: "expire", quantity: -balance, key: expireEntryKey(grant.id, grant.expiresAt) });
  }
  await setGrantStatus(tx, ctx, grant, "expired");
  await ctx.recordEvent({
    kind: "credits.grant_expired",
    personId: grant.personId,
    ref: grantRef(grant.id),
    dedupeKey: `grant:${grant.id}:expired:${expireEntryKey(grant.id, grant.expiresAt).split(":").pop()}`,
    data: { grant_id: grant.id, credit_kind: grant.creditKind, units: Math.max(balance, 0), source: grant.source },
  });
  return { expired: true, units: Math.max(balance, 0) };
}

/** Active grants with `expires_at <= now`, ascending id after `afterId`, at most `limit`. */
export async function dueExpiries(db: DbOrTx, now: Date, afterId: string | undefined, limit: number): Promise<{ id: string; expiresAt: Date }[]> {
  const rows = await db
    .select({ id: creditGrants.id, expiresAt: creditGrants.expiresAt })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.status, "active"),
        sql`${creditGrants.expiresAt} <= ${now.toISOString()}::timestamptz`,
        afterId ? sql`${creditGrants.id} > ${afterId}::uuid` : sql`true`,
      ),
    )
    .orderBy(asc(creditGrants.id))
    .limit(limit);
  return rows.map((r) => ({ id: r.id, expiresAt: r.expiresAt! }));
}

/**
 * Usable grants with units left that expire within the largest warning window (plus a day),
 * for `credits.expiry_approaching` (rule 30). Balances from the ledger at `now`.
 */
export async function expiryWarningCandidates(
  db: DbOrTx,
  now: Date,
  maxDays: number,
): Promise<{ grantId: string; personId: string; creditKind: CreditKind; expiresAt: Date; remainingUnits: number }[]> {
  const until = new Date(now.getTime() + (maxDays + 2) * 86_400_000);
  const rows = await db
    .select({
      grantId: creditGrants.id,
      personId: creditGrants.personId,
      creditKind: creditGrants.creditKind,
      expiresAt: creditGrants.expiresAt,
      remaining: sql<number>`(select coalesce(sum(e.quantity), 0)::int from credit_entries e where e.grant_id = credit_grants.id)`,
    })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.status, "active"),
        sql`${creditGrants.startsAt} <= ${now.toISOString()}::timestamptz`,
        sql`${creditGrants.expiresAt} > ${now.toISOString()}::timestamptz and ${creditGrants.expiresAt} <= ${until.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(creditGrants.id));
  return rows
    .map((r) => ({ grantId: r.grantId, personId: r.personId, creditKind: r.creditKind, expiresAt: r.expiresAt!, remainingUnits: Number(r.remaining) }))
    .filter((r) => r.remainingUnits > 0);
}

// ---------------------------------------------------------------------------
// Reads for other modules
// ---------------------------------------------------------------------------

/** Units granted, used and remaining per grant of an order line (commerce builds a package refund from it, rule 27). */
export async function getGrantUsage(
  db: DbOrTx,
  orderLineId: string,
): Promise<{
  grants: { grantId: string; unitsGranted: number; usedUnits: number; remainingUnits: number; status: GrantStatus; unitValueCents: number }[];
}> {
  if (!UUID_RE.test(orderLineId)) return { grants: [] };
  const rows = await db
    .select({
      grantId: vCreditGrantBalances.grantId,
      unitsGranted: vCreditGrantBalances.unitsGranted,
      usedUnits: vCreditGrantBalances.usedUnits,
      remainingUnits: vCreditGrantBalances.remainingUnits,
      status: vCreditGrantBalances.status,
      unitValueCents: vCreditGrantBalances.unitValueCents,
    })
    .from(vCreditGrantBalances)
    .innerJoin(creditGrants, eq(creditGrants.id, vCreditGrantBalances.grantId))
    .where(eq(creditGrants.orderLineId, orderLineId))
    .orderBy(asc(creditGrants.lineUnitIndex), asc(creditGrants.id));
  return { grants: rows.map((r) => ({ ...r, unitsGranted: Number(r.unitsGranted), usedUnits: Number(r.usedUnits), remainingUnits: Number(r.remainingUnits), unitValueCents: Number(r.unitValueCents) })) };
}

/** The usable store credit of a person (euro grants, cents), in allocation order (rule 20). */
export async function getEuroBalance(
  db: DbOrTx,
  personId: string,
): Promise<{ remainingCents: number; grants: { grantId: string; remainingCents: number; expiresAt: Date | null }[] }> {
  if (!UUID_RE.test(personId)) return { remainingCents: 0, grants: [] };
  const rows = await db
    .select({ grantId: vCreditGrantBalances.grantId, remaining: vCreditGrantBalances.remainingUnits, expiresAt: vCreditGrantBalances.expiresAt })
    .from(vCreditGrantBalances)
    .where(and(eq(vCreditGrantBalances.personId, personId), eq(vCreditGrantBalances.creditKind, "euro"), eq(vCreditGrantBalances.isUsable, true)))
    .orderBy(sql`${vCreditGrantBalances.expiresAt} asc nulls last`, asc(vCreditGrantBalances.startsAt), asc(vCreditGrantBalances.grantId));
  const grants = rows.map((r) => ({ grantId: r.grantId, remainingCents: Number(r.remaining), expiresAt: r.expiresAt }));
  return { remainingCents: grants.reduce((n, g) => n + g.remainingCents, 0), grants };
}

/** Totals per kind, the live membership and the commercial status of a person (crm person page, booking desk). */
export async function getPersonCreditSummary(
  db: DbOrTx,
  personId: string,
): Promise<{
  byKind: { kind: CreditKind; remainingUnits: number; nextExpiresAt: Date | null }[];
  membership: { id: string; status: string; periodEndAt: Date; planName: LocalizedText } | null;
  status: "lead" | "customer" | "member";
  derivedStatus: "lead" | "customer" | "member";
}> {
  if (!UUID_RE.test(personId)) throw new NotFoundError("person_not_found");
  const kinds = await db
    .select({ kind: vPersonCredits.creditKind, remainingUnits: vPersonCredits.remainingUnits, nextExpiresAt: vPersonCredits.nextExpiresAt })
    .from(vPersonCredits)
    .where(eq(vPersonCredits.personId, personId));
  const order: CreditKind[] = ["day", "night", "euro"];
  const byKind = kinds.map((k) => ({ ...k, remainingUnits: Number(k.remainingUnits) })).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const [m] = await db
    .select({ id: memberships.id, status: memberships.status, periodEndAt: memberships.currentPeriodEndAt, planName: products.name })
    .from(memberships)
    .innerJoin(products, eq(products.id, memberships.productId))
    .where(and(eq(memberships.personId, personId), inArray(memberships.status, ["active", "past_due"])))
    .orderBy(sql`${memberships.startedAt} desc`)
    .limit(1);
  const [s] = await db
    .select({ status: vPersonStatus.status, derived: vPersonStatus.derivedStatus })
    .from(vPersonStatus)
    .where(eq(vPersonStatus.personId, personId));
  return {
    byKind,
    membership: m ? { id: m.id, status: m.status, periodEndAt: m.periodEndAt, planName: m.planName } : null,
    status: s?.status ?? "lead",
    derivedStatus: s?.derived ?? "lead",
  };
}

/**
 * The prepaid liability as it stood at `at` (finance month close, D29): like `v_credit_liability`,
 * from entries with `created_at <= at` on grants with `starts_at <= at` and a positive balance then.
 */
export async function getCreditLiabilityAsOf(
  db: DbOrTx,
  at: Date,
): Promise<{ kind: CreditKind; vatTreatment: string; vatRatePct: number | null; remainingUnits: number; remainingValueCents: number }[]> {
  const iso = at.toISOString();
  const result = await db.execute(sql`
    select g.credit_kind, g.vat_treatment, g.vat_rate_pct,
           sum(b.remaining)::bigint as remaining_units,
           sum(b.remaining * g.unit_value_cents)::bigint as remaining_value_cents
    from credit_grants g
    join (select grant_id, sum(quantity) as remaining from credit_entries
          where created_at <= ${iso}::timestamptz group by grant_id) b on b.grant_id = g.id
    where g.starts_at <= ${iso}::timestamptz and b.remaining > 0
    group by g.credit_kind, g.vat_treatment, g.vat_rate_pct
    order by g.credit_kind, g.vat_treatment, g.vat_rate_pct nulls first`);
  type Row = { credit_kind: CreditKind; vat_treatment: string; vat_rate_pct: string | null; remaining_units: string | number; remaining_value_cents: string | number };
  const rows = ((result as { rows?: Row[] }).rows ?? (result as Row[]));
  return rows.map((r) => ({
    kind: r.credit_kind,
    vatTreatment: r.vat_treatment,
    vatRatePct: r.vat_rate_pct === null ? null : Number(r.vat_rate_pct),
    remainingUnits: Number(r.remaining_units),
    remainingValueCents: Number(r.remaining_value_cents),
  }));
}

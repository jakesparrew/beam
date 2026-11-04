/**
 * Promotions (commerce spec rules 13, 17 and 18, commerce-P3): staff writes with the locked
 * fields of rule 18, and `loadEligiblePromotions`, which decides eligibility (rule 17) before
 * the pure `quote()` runs.
 *
 * Codes are stored upper case (`promotions_code_chk`); uniqueness is the partial unique index
 * `promotions_code_uq`, checked first so the form gets a field error.
 */
import { z } from "zod";
import { orders, promotionRedemptions, promotions } from "@beam/db/schema";
import { ORDER_CHANNELS, PRODUCT_KINDS, PROMOTION_KINDS, normalisePromoCode, type OrderChannel, type PromotionRow } from "@beam/core/commerce";
import { LocalizedTextSchema, missingLocales, type LocalizedText } from "@beam/core/i18n";
import { and, eq, gt, isNotNull, isNull, lte, ne, or, sql, ConflictError, NotFoundError, ValidationError, type Ctx, type DbOrTx } from "@/lib/ctx";
import { getPersonStatus, isInSegment } from "@/modules/crm/api";

export type PromotionDbRow = typeof promotions.$inferSelect;
export type EligiblePromotion = PromotionRow & { isEligible: boolean };

const PERSON_STATUSES = ["lead", "customer", "member"] as const;

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const code = z
  .string()
  .trim()
  .transform((c) => c.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{4,24}$/, "code_format"));

export const PromotionFields = z.object({
  code: z.union([code, z.literal("").transform(() => null), z.null()]).optional(),
  name: LocalizedTextSchema,
  kind: z.enum(PROMOTION_KINDS),
  value: z.number().int().positive(),
  appliesTo: z
    .object({ productIds: z.array(z.uuid()).max(200).default([]), productKinds: z.array(z.enum(PRODUCT_KINDS)).default([]) })
    .default({ productIds: [], productKinds: [] }),
  eligibility: z
    .object({
      segmentId: z.uuid().optional(),
      statuses: z.array(z.enum(PERSON_STATUSES)).optional(),
      channels: z.array(z.enum(ORDER_CHANNELS)).optional(),
      firstOrderOnly: z.boolean().optional(),
    })
    .default({}),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  maxUsesPerPerson: z.number().int().positive().nullable().optional(),
  isActive: z.boolean().default(true),
});
export const CreatePromotionInput = PromotionFields;
export const UpdatePromotionInput = PromotionFields.extend({ promotionId: z.uuid() });
export type PromotionFieldsValue = z.output<typeof PromotionFields>;

type PromotionColumns = Omit<typeof promotions.$inferInsert, "id" | "createdAt" | "updatedAt" | "usesCount" | "createdByUserId">;

/** Row values with the shape checks of the table (field errors instead of check violations). */
export function promotionColumns(v: PromotionFieldsValue): PromotionColumns {
  const fields: Record<string, string> = {};
  if (v.kind === "percent" && v.value > 100) fields.value = "percent_range";
  if (v.endsAt && v.endsAt.getTime() <= v.startsAt.getTime()) fields.endsAt = "after_start";
  const codeValue = normalisePromoCode(v.code ?? null);
  const isNamed = codeValue !== null || v.isActive;
  const missing = isNamed ? missingLocales(v.name) : [];
  if (missing.length) fields.name = missing.join(",");
  if (Object.keys(fields).length) throw new ValidationError(missing.length && Object.keys(fields).length === 1 ? "missing_translation" : "validation", fields);
  const e = v.eligibility;
  return {
    code: codeValue,
    name: v.name,
    kind: v.kind,
    value: v.value,
    appliesTo: { product_ids: [...new Set(v.appliesTo.productIds)], product_kinds: [...new Set(v.appliesTo.productKinds)] },
    eligibility: {
      ...(e.segmentId ? { segment_id: e.segmentId } : {}),
      ...(e.statuses?.length ? { statuses: [...new Set(e.statuses)] } : {}),
      ...(e.channels?.length ? { channels: [...new Set(e.channels)] } : {}),
      ...(e.firstOrderOnly ? { first_order_only: true } : {}),
    },
    startsAt: v.startsAt,
    endsAt: v.endsAt ?? null,
    maxUses: v.maxUses ?? null,
    maxUsesPerPerson: v.maxUsesPerPerson ?? null,
    isActive: v.isActive,
  };
}

async function codeTaken(tx: DbOrTx, value: string | null, exceptId?: string): Promise<boolean> {
  if (value === null) return false;
  const rows = await tx.select({ id: promotions.id }).from(promotions).where(eq(promotions.code, value));
  return rows.some((r) => r.id !== exceptId);
}

function staffUserId(ctx: Ctx): string {
  if (ctx.actor.kind !== "staff") throw new ValidationError("staff_only");
  return ctx.actor.userId;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** `createPromotion`: code upper-cased and unique; a code promotion or an active one needs its name in every locale. */
export async function createPromotionRecord(ctx: Ctx, input: PromotionFieldsValue): Promise<{ promotionId: string }> {
  const values = promotionColumns(input);
  if (await codeTaken(ctx.tx, values.code ?? null)) throw new ValidationError("validation", { code: "code_taken" });
  const [row] = await ctx.tx
    .insert(promotions)
    .values({ ...values, createdByUserId: staffUserId(ctx) })
    .returning();
  await ctx.audit({ action: "promotion.created", entityType: "promotion", entityId: row!.id, newValue: row });
  return { promotionId: row!.id };
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(normaliseJson(a)) === JSON.stringify(normaliseJson(b));
function normaliseJson(v: unknown): unknown {
  if (Array.isArray(v)) return [...v].map(normaliseJson).sort();
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normaliseJson(x)]));
  return v;
}

/** The fields rule 18 locks once a promotion has been used, that this update would change. */
export function lockedFieldChanges(before: PromotionDbRow, after: PromotionColumns): string[] {
  if (before.usesCount <= 0) return [];
  const changed: string[] = [];
  if (before.kind !== after.kind) changed.push("kind");
  if (before.value !== after.value) changed.push("value");
  if (!sameJson(before.appliesTo, after.appliesTo)) changed.push("appliesTo");
  if ((before.code ?? null) !== (after.code ?? null)) changed.push("code");
  if (before.startsAt.getTime() !== after.startsAt!.getTime()) changed.push("startsAt");
  if (!sameJson(before.eligibility, after.eligibility)) changed.push("eligibility");
  return changed;
}

/**
 * `updatePromotion` (rule 18): once `uses_count > 0` only `name`, `ends_at`, `max_uses` (not below
 * `uses_count`), `max_uses_per_person` and `is_active` can change; anything else is `conflict`
 * `promotion_locked` with the fields in the message.
 */
export async function updatePromotionRecord(ctx: Ctx, input: z.output<typeof UpdatePromotionInput>): Promise<{ promotionId: string }> {
  const { promotionId, ...fields } = input;
  const [before] = await ctx.tx.select().from(promotions).where(eq(promotions.id, promotionId)).for("update");
  if (!before) throw new NotFoundError("promotion_not_found");
  const values = promotionColumns(fields);
  const locked = lockedFieldChanges(before, values);
  if (locked.length) throw new ConflictError(`promotion_locked:${locked.join(",")}`);
  if (values.maxUses != null && values.maxUses < before.usesCount) throw new ValidationError("validation", { maxUses: "below_uses" });
  if (values.code !== before.code && (await codeTaken(ctx.tx, values.code ?? null, promotionId))) throw new ValidationError("validation", { code: "code_taken" });
  const [after] = await ctx.tx
    .update(promotions)
    .set({ ...values, updatedAt: sql`now()` })
    .where(eq(promotions.id, promotionId))
    .returning();
  await ctx.audit({ action: "promotion.updated", entityType: "promotion", entityId: promotionId, oldValue: before, newValue: after });
  return { promotionId };
}

// ---------------------------------------------------------------------------
// Eligibility (rule 17)
// ---------------------------------------------------------------------------

export function toPromotionRow(r: PromotionDbRow): PromotionRow {
  return {
    id: r.id,
    code: r.code,
    name: r.name as LocalizedText,
    kind: r.kind,
    value: r.value,
    appliesTo: { productIds: r.appliesTo.product_ids ?? [], productKinds: r.appliesTo.product_kinds ?? [] },
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    maxUses: r.maxUses,
    usesCount: r.usesCount,
    isActive: r.isActive,
  };
}

/** Non-released redemptions of `promotionId` by `personId` (the per-person limit counts these). */
export async function countPersonRedemptions(db: DbOrTx, promotionId: string, personId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(promotionRedemptions)
    .where(and(eq(promotionRedemptions.promotionId, promotionId), eq(promotionRedemptions.personId, personId), ne(promotionRedemptions.status, "released")));
  return Number(row?.n ?? 0);
}

async function hasPaidOrder(db: DbOrTx, personId: string): Promise<boolean> {
  const rows = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.personId, personId), isNotNull(orders.paidAt)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Whether `personId` (null = anonymous buyer) may use the promotion on `channel` at `at`
 * (rule 17): active, `starts_at <= at < ends_at`, channel listed (when set), person status
 * (crm's, which respects a staff override) listed (when set), segment membership (when set),
 * no earlier paid order (`first_order_only`), and fewer non-released redemptions than
 * `max_uses_per_person`. Anonymous buyers qualify only without segment, status or first-order rules.
 */
export async function isPromotionEligible(
  db: DbOrTx,
  promotion: PromotionDbRow,
  input: { personId: string | null; channel: OrderChannel; at: Date },
  cache: { status?: Promise<string>; paid?: Promise<boolean> } = {},
): Promise<boolean> {
  const { personId, channel, at } = input;
  if (!promotion.isActive) return false;
  if (promotion.startsAt.getTime() > at.getTime()) return false;
  if (promotion.endsAt && promotion.endsAt.getTime() <= at.getTime()) return false;
  const e = promotion.eligibility ?? {};
  if (e.channels?.length && !e.channels.includes(channel)) return false;
  const needsPerson = !!e.segment_id || !!e.statuses?.length || !!e.first_order_only;
  if (!personId) return !needsPerson;
  if (e.statuses?.length) {
    cache.status ??= getPersonStatus(db, personId).then((s) => s.status);
    if (!(e.statuses as string[]).includes(await cache.status)) return false;
  }
  if (e.first_order_only) {
    cache.paid ??= hasPaidOrder(db, personId);
    if (await cache.paid) return false;
  }
  if (e.segment_id && !(await isInSegment(db, e.segment_id, personId))) return false;
  if (promotion.maxUsesPerPerson != null && (await countPersonRedemptions(db, promotion.id, personId)) >= promotion.maxUsesPerPerson) return false;
  return true;
}

/**
 * The promotions a quote considers: every automatic promotion live at `at`, plus the promotion
 * whose code was typed (whatever its state, so `quote()` can name the reason it is refused, rule
 * 13). Each carries `isEligible` from `isPromotionEligible`.
 */
export async function loadEligiblePromotions(
  tx: DbOrTx,
  input: { personId: string | null; channel: OrderChannel; code: string | null; at: Date },
): Promise<EligiblePromotion[]> {
  const typed = normalisePromoCode(input.code);
  const live = and(isNull(promotions.code), eq(promotions.isActive, true), lte(promotions.startsAt, input.at), or(isNull(promotions.endsAt), gt(promotions.endsAt, input.at)));
  const rows = await tx
    .select()
    .from(promotions)
    .where(typed ? or(live, eq(promotions.code, typed)) : live);
  const cache = {};
  const out: EligiblePromotion[] = [];
  for (const r of rows) {
    out.push({ ...toPromotionRow(r), isEligible: await isPromotionEligible(tx, r, input, cache) });
  }
  return out;
}

/**
 * Gift vouchers after payment (commerce spec rules 45 to 47a, edge cases 19, 20, 35; commerce-P6).
 *
 * - `redeemVoucher`: the code (normalised, sha256 lookup) names one voucher, locked `FOR UPDATE`;
 *   it must be `active` and not expired. The redeemer receives euro credit through
 *   `credits.grantCredits` (source `voucher`, key `grant:voucher:<id>`), the grant id is stored in
 *   `credit_grant_id` and the voucher is `redeemed`, once. Five failed code attempts per IP or
 *   person per hour block further attempts (`voucher:ip:<ip>`, `voucher:person:<id>`); failures
 *   are counted with a durable write, so they survive the rolled-back attempt, and a success
 *   does not count.
 * - `issueVoucherEmail` (job `commerce.issue_voucher_email`): renders the voucher PDF with the
 *   derived code and sends `commerce.gift_voucher` to the recipient (or the purchaser), dated
 *   `deliver_on` 09:00 Brussels when that lies ahead (rule 45a); stores `email_message_id`.
 * - `resendVoucher`, `voidVoucher` (staff) and `expireVouchers` (job `commerce.expire_vouchers`,
 *   daily: `active -> expired` with `voucher.expired`, and `voucher.expiring {days: 30}` once).
 */
import { files, jobs, orderLines, orders, persons, rateLimits, vouchers } from "@beam/db/schema";
import { deriveVoucherCode, hashVoucherCode, isVoucherCodeFormat, nextVoucherStatus } from "@beam/core/commerce";
import { PermanentError } from "@beam/core/errors";
import { formatDate, formatMoney, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { retryAfterSeconds, windowStart } from "@beam/core/platform";
import { appUrl } from "@/lib/auth";
import { and, asc, eq, gt, inArray, lte, sql, writeDurably, ConflictError, NotFoundError, RateLimitedError, ValidationError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { storeFile } from "@/lib/files";
import type { JobCtx } from "@/lib/job-runner";
import { rateLimit } from "@/lib/rate-limit";
import { grantCredits } from "@/modules/credits/api";
import { sendTransactional } from "@/modules/email/api";
import { renderVoucherPdf } from "../ui/voucher-pdf";
import { brusselsMidnight, commerceSettings } from "./paid";
import { voidVouchers } from "./refunds";

export type VoucherRow = typeof vouchers.$inferSelect;

/** Rule 47: one hour window. */
export const VOUCHER_WINDOW_SECONDS = 3600;

function voucherSecret(): string {
  const secret = process.env.VOUCHER_CODE_SECRET;
  if (!secret) throw new PermanentError("voucher_code_secret_missing");
  return secret;
}

/** The rate-limit keys of an attempt (rule 47). */
export function voucherLimitKeys(input: { ip: string | null; personId: string | null }): string[] {
  return [input.ip ? `voucher:ip:${input.ip}` : null, input.personId ? `voucher:person:${input.personId}` : null].filter((k): k is string => !!k);
}

/** True when any key already holds `limit` failed attempts in the current window. */
async function isBlocked(db: DbOrTx, keys: string[], limit: number, now: Date): Promise<boolean> {
  if (!keys.length) return false;
  const start = windowStart(now, VOUCHER_WINDOW_SECONDS);
  const rows = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(inArray(rateLimits.key, keys), eq(rateLimits.windowStart, start)));
  return rows.some((r) => Number(r.count) >= limit);
}

/** Counts one failed attempt per key, durably (it must survive the rollback of the attempt). */
async function countFailure(ctx: Ctx, keys: string[], limit: number): Promise<void> {
  const now = ctx.now;
  await writeDurably(ctx, async (db) => {
    for (const key of keys) await rateLimit(db, { key, limit, windowSeconds: VOUCHER_WINDOW_SECONDS }, now);
  });
}

export type RedeemResult = { grantId: string; amountCents: number; expiresAt: Date };

/**
 * Redeems `code` for `personId` (rule 45). Errors: `voucher_invalid` (unknown code; counted),
 * `voucher_used`, `voucher_expired`, `rate_limited`.
 */
export async function redeemVoucher(tx: Tx, ctx: Ctx, input: { code: string; personId: string }): Promise<RedeemResult> {
  const settings = await commerceSettings(tx);
  const limit = settings.max_voucher_attempts_per_hour;
  const keys = voucherLimitKeys({ ip: ctx.ip, personId: input.personId });
  if (await isBlocked(tx, keys, limit, ctx.now)) throw new RateLimitedError(retryAfterSeconds(ctx.now, VOUCHER_WINDOW_SECONDS));

  const invalid = async (): Promise<never> => {
    await countFailure(ctx, keys, limit);
    throw new ValidationError("voucher_invalid", { code: "voucher_invalid" });
  };
  if (!isVoucherCodeFormat(input.code)) return invalid();
  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(eq(vouchers.codeHash, await hashVoucherCode(input.code)))
    .for("update");
  if (!voucher) return invalid();
  if (voucher.status === "redeemed") throw new ConflictError("voucher_used");
  if (voucher.status === "expired" || (voucher.status === "active" && voucher.expiresAt && voucher.expiresAt.getTime() <= ctx.now.getTime())) {
    throw new ConflictError("voucher_expired");
  }
  if (voucher.status !== "active" || !voucher.expiresAt) return invalid();

  const grant = await grantCredits(tx, ctx, {
    personId: input.personId,
    kind: "euro",
    units: voucher.amountCents,
    source: "voucher",
    orderLineId: voucher.orderLineId,
    voucherId: voucher.id,
    unitValueCents: 1,
    expiresAt: voucher.expiresAt,
    key: `grant:voucher:${voucher.id}`,
  });
  await tx
    .update(vouchers)
    .set({ status: "redeemed", redeemedByPersonId: input.personId, redeemedAt: ctx.now, creditGrantId: grant.grantId, updatedAt: ctx.now })
    .where(eq(vouchers.id, voucher.id));
  await ctx.recordEvent({
    kind: "voucher.redeemed",
    personId: input.personId,
    ref: { type: "voucher", id: voucher.id },
    dedupeKey: `voucher:${voucher.id}:redeemed`,
    data: { voucher_id: voucher.id },
  });
  if (ctx.actor.kind === "staff") {
    await ctx.audit({ action: "voucher.redeemed", entityType: "voucher", entityId: voucher.id, personId: input.personId, newValue: { amountCents: voucher.amountCents } });
  }
  return { grantId: grant.grantId, amountCents: voucher.amountCents, expiresAt: voucher.expiresAt };
}

// ---------------------------------------------------------------------------
// The voucher email (rule 45a)
// ---------------------------------------------------------------------------

/** 09:00 Europe/Brussels on `YYYY-MM-DD`. */
export function deliveryInstant(day: string): Date {
  return new Date(brusselsMidnight(day).getTime() + 9 * 3_600_000);
}

export type VoucherEmailResult = { skipped: true; status: VoucherRow["status"] } | { emailMessageId: string; fileId: string; sendAt: Date | null };

/** `commerce.issue_voucher_email` (key `voucher_email:<voucher_id>:<n>`, 0 for the first send). */
export async function issueVoucherEmail(ctx: JobCtx | Ctx, input: { voucherId: string; n: number; email?: string | undefined }): Promise<VoucherEmailResult> {
  const tx = ctx.tx;
  const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, input.voucherId)).for("update");
  if (!voucher) throw new NotFoundError("voucher_not_found");
  if (voucher.status !== "active" || !voucher.expiresAt) return { skipped: true, status: voucher.status };
  const [row] = await tx
    .select({ order: orders })
    .from(orderLines)
    .innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(eq(orderLines.id, voucher.orderLineId));
  if (!row) throw new NotFoundError("order_not_found");
  const order = row.order;
  const locale = order.locale as Locale;
  const purchaserId = voucher.purchaserPersonId ?? order.personId;
  const [purchaser] = purchaserId ? await tx.select({ email: persons.email, firstName: persons.firstName }).from(persons).where(eq(persons.id, purchaserId)) : [];
  const to = input.email ?? voucher.recipientEmail ?? purchaser?.email ?? null;
  if (!to) throw new PermanentError(`voucher_without_address: ${voucher.id}`);

  const code = await deriveVoucherCode(voucherSecret(), voucher.id);
  const redeemUrl = appUrl(`/${URL_SEGMENT[locale]}/account/orders#redeem`);
  const name = `voucher-${voucher.id}.pdf`;
  const [existing] = await tx.select({ id: files.id }).from(files).where(and(eq(files.kind, "receipt"), eq(files.name, name)));
  let fileId = existing?.id ?? null;
  if (!fileId) {
    const bytes = await renderVoucherPdf({ locale, code, amountCents: voucher.amountCents, recipientName: voucher.recipientName, message: voucher.message, expiresAt: voucher.expiresAt, redeemUrl });
    fileId = (await storeFile(ctx, { kind: "receipt", name, mime: "application/pdf", bytes, ...(purchaserId ? { personId: purchaserId } : {}) })).fileId;
  }
  const at = input.n === 0 && voucher.deliverOn ? deliveryInstant(voucher.deliverOn) : null;
  const sendAt = at && at.getTime() > ctx.now.getTime() ? at : null;
  const sent = await sendTransactional(ctx, {
    template: "commerce.gift_voucher",
    ...(purchaserId ? { personId: purchaserId } : {}),
    to,
    locale,
    data: {
      code,
      amount: formatMoney(voucher.amountCents, locale),
      recipientName: voucher.recipientName ?? "",
      message: voucher.message ?? "",
      validUntil: formatDate(voucher.expiresAt, locale, "long"),
      redeemUrl,
    },
    key: `voucher:${voucher.id}:email:${input.n}`,
    attachments: [{ fileId, filename: "BEAM-gift-voucher.pdf" }],
    ...(sendAt ? { sendAt } : {}),
  });
  await tx.update(vouchers).set({ emailMessageId: sent.emailMessageId, updatedAt: ctx.now }).where(eq(vouchers.id, voucher.id));
  return { emailMessageId: sent.emailMessageId, fileId, sendAt };
}

/** `resendVoucher` (staff): a new send with key `voucher_email:<id>:<n>`, n = sends so far. */
export async function resendVoucher(tx: Tx, ctx: Ctx, input: { voucherId: string; email?: string | undefined }): Promise<{ ok: true; n: number }> {
  const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, input.voucherId)).for("update");
  if (!voucher) throw new NotFoundError("voucher_not_found");
  if (voucher.status !== "active") throw new ConflictError("invalid_transition");
  const [count] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(sql`${jobs.idempotencyKey} like ${`voucher_email:${voucher.id}:%`}`);
  const n = Math.max(1, Number(count?.n ?? 0));
  await ctx.enqueue({
    kind: "commerce.issue_voucher_email",
    payload: { voucherId: voucher.id, n, ...(input.email ? { email: input.email } : {}) },
    key: `voucher_email:${voucher.id}:${n}`,
  });
  await ctx.audit({ action: "voucher.resent", entityType: "voucher", entityId: voucher.id, newValue: { n, toOther: !!input.email } });
  return { ok: true, n };
}

/** `voidVoucher` (staff, `commerce.refund`): an `active` voucher becomes `void`; a scheduled email is withdrawn. */
export async function voidVoucher(tx: Tx, ctx: Ctx, input: { voucherId: string; reason: string }): Promise<{ ok: true }> {
  const [voucher] = await tx.select().from(vouchers).where(eq(vouchers.id, input.voucherId));
  if (!voucher) throw new NotFoundError("voucher_not_found");
  if (nextVoucherStatus(voucher.status, "void") === null) throw new ConflictError("invalid_transition");
  await voidVouchers(tx, ctx, [voucher.id], input.reason.trim());
  await ctx.audit({ action: "voucher.voided", entityType: "voucher", entityId: voucher.id, oldValue: { status: voucher.status }, newValue: { status: "void", reason: input.reason.trim() } });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// commerce.expire_vouchers (rule 47a)
// ---------------------------------------------------------------------------

export type ExpireVouchersResult = { expired: number; expiring: number };

const BATCH = 500;

/** `active` vouchers past `expires_at` become `expired`; the ones expiring within 30 days get `voucher.expiring` once. */
export async function expireVouchers(ctx: JobCtx | Ctx): Promise<ExpireVouchersResult> {
  const tx = ctx.tx;
  const settings = await commerceSettings(tx);
  const days = settings.voucher_expiry_warning_days;
  let expired = 0;
  for (;;) {
    const rows = await tx
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.status, "active"), lte(vouchers.expiresAt, ctx.now)))
      .orderBy(asc(vouchers.expiresAt), asc(vouchers.id))
      .limit(BATCH)
      .for("update", { skipLocked: true });
    if (!rows.length) break;
    for (const v of rows) {
      await tx.update(vouchers).set({ status: "expired", updatedAt: ctx.now }).where(eq(vouchers.id, v.id));
      if (v.purchaserPersonId) {
        await ctx.recordEvent({ kind: "voucher.expired", personId: v.purchaserPersonId, ref: { type: "voucher", id: v.id }, dedupeKey: `voucher:${v.id}:expired`, data: { voucher_id: v.id } });
      }
      expired++;
    }
    if (rows.length < BATCH) break;
  }

  const horizon = new Date(ctx.now.getTime() + days * 86_400_000);
  const soon = await tx
    .select({ id: vouchers.id, personId: vouchers.purchaserPersonId })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.status, "active"),
        gt(vouchers.expiresAt, ctx.now),
        lte(vouchers.expiresAt, horizon),
        sql`not exists (select 1 from activity_events e where e.dedupe_key = 'voucher:' || ${vouchers.id}::text || ':expiring:' || ${String(days)})`,
      ),
    )
    .orderBy(asc(vouchers.expiresAt))
    .limit(BATCH);
  let expiring = 0;
  for (const v of soon) {
    if (!v.personId) continue;
    const r = await ctx.recordEvent({
      kind: "voucher.expiring",
      personId: v.personId,
      ref: { type: "voucher", id: v.id },
      dedupeKey: `voucher:${v.id}:expiring:${days}`,
      data: { voucher_id: v.id, days },
    });
    if (r.id !== null) expiring++;
  }
  return { expired, expiring };
}

/**
 * Abandoned checkout recovery (commerce spec rules 51 and 52, R2; commerce-P8).
 *
 * - Resume links: `getCheckoutRecoveryProps` (called by automation's recovery step, A-31a) gives
 *   the checkout one resume token. The token is an HMAC of the checkout id, so every call returns
 *   the same URL while only its sha256 is stored (`checkouts.resume_token_hash`, unique: one
 *   token opens exactly one checkout). `/[locale]/checkout/resume/[token]` looks the checkout up
 *   by that hash and re-quotes it on open.
 * - `markCheckoutRecoveryMessage` stores the recovery email once (only while null), so the first
 *   recovery email is the attributed one.
 * - Attribution (inside `checkouts.mark_abandoned`): an abandoned checkout is recovered when the
 *   same person pays an order within `recovery_window_days` (7) after `abandoned_at` containing at
 *   least one of the checkout's products; `recovered_order_id`, `recovered_at` are set and
 *   `checkout.recovered` is written (dedupe `checkout:<id>:recovered`). A still-null
 *   `recovery_message_id` is filled from `email.findLatestMessage` (cross-module D54), so
 *   attribution never depends on the automation's link call. Recovery revenue is the order's
 *   `total_cents` (ops' `v_abandoned_checkouts` reads it through `recovered_order_id`).
 */
import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { checkouts, orderLines, orders } from "@beam/db/schema";
import type { CartItem, ProductCard } from "@beam/core/commerce";
import { isLocale, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lte, sql, NotFoundError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { appUrl } from "@/lib/auth";
import { findLatestMessage } from "@/modules/email/api";
import { getProductCards } from "./catalogue";
import { commerceSettings } from "./paid";

/** The registry template of both recovery reminders (rule 52, cross-module D54). */
export const RECOVERY_TEMPLATE = "commerce.checkout_recovery";
/** Order statuses that count as paid for attribution (a later refund keeps the recovery). */
export const RECOVERED_ORDER_STATUSES = ["paid", "partially_refunded", "refunded"] as const;
const DAY_MS = 24 * 60 * 60_000;
const BATCH = 500;
/** `[A-Za-z0-9_-]{43}`: 32 HMAC bytes in base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

// ---------------------------------------------------------------------------
// Resume tokens
// ---------------------------------------------------------------------------

function resumeSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") throw new Error("AUTH_SECRET is not set");
  return "beam-dev-checkout-resume";
}

/** The raw resume token of a checkout (never stored). */
export function resumeTokenFor(checkoutId: string): string {
  return createHmac("sha256", resumeSecret()).update(`checkout_resume:${checkoutId}`).digest("base64url");
}

/** `resume_token_hash`: sha256 hex of the raw token. */
export function hashResumeToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The absolute resume link `<APP_URL>/<l>/checkout/resume/<token>`. */
export function resumeUrlFor(token: string, locale: Locale): string {
  return appUrl(`/${URL_SEGMENT[locale]}/checkout/resume/${token}`);
}

const localeOf = (value: string): Locale => (isLocale(value) ? value : "nl-BE");

/**
 * Props of `commerce.checkout_recovery` for automation (A-31a): the resume URL (the token is
 * stored once; a hash written under an earlier secret is replaced), the checkout's products as
 * cards in the checkout's locale, the quote total at the last save and that locale.
 */
export async function getCheckoutRecoveryProps(
  tx: Tx,
  checkoutId: string,
): Promise<{ resumeUrl: string; items: ProductCard[]; totalCents: number; locale: Locale }> {
  if (!z.uuid().safeParse(checkoutId).success) throw new NotFoundError("checkout_not_found");
  const [c] = await tx.select().from(checkouts).where(eq(checkouts.id, checkoutId));
  if (!c) throw new NotFoundError("checkout_not_found");
  const token = resumeTokenFor(c.id);
  const hash = hashResumeToken(token);
  if (c.resumeTokenHash !== hash) {
    await tx.update(checkouts).set({ resumeTokenHash: hash, updatedAt: new Date() }).where(eq(checkouts.id, c.id));
  }
  const locale = localeOf(c.locale);
  const items = (c.items as CartItem[] | null) ?? [];
  const productIds = [...new Set(items.map((i) => i.productId))];
  return { resumeUrl: resumeUrlFor(token, locale), items: await getProductCards(tx, productIds, locale), totalCents: c.totalCents ?? 0, locale };
}

export type ResumeTarget = {
  checkoutId: string;
  channel: "portal" | "site";
  status: "started" | "abandoned" | "completed" | "expired";
  /** `started` or `abandoned` and before `expires_at`: the customer can continue. */
  isOpen: boolean;
  locale: Locale;
};

/** The one checkout a resume token opens, or null for a malformed or unknown token. */
export async function findCheckoutByResumeToken(db: DbOrTx, token: string, now: Date = new Date()): Promise<ResumeTarget | null> {
  if (!TOKEN.test(token)) return null;
  const [c] = await db
    .select({ id: checkouts.id, channel: checkouts.channel, status: checkouts.status, expiresAt: checkouts.expiresAt, locale: checkouts.locale })
    .from(checkouts)
    .where(eq(checkouts.resumeTokenHash, hashResumeToken(token)));
  if (!c) return null;
  const isOpen = (c.status === "started" || c.status === "abandoned") && c.expiresAt.getTime() > now.getTime();
  return { checkoutId: c.id, channel: c.channel, status: c.status, isOpen, locale: localeOf(c.locale) };
}

/** The checkout page a resumed checkout continues on (`?checkout=<id>`). */
export function resumeContinuePath(target: Pick<ResumeTarget, "checkoutId" | "channel">, locale: Locale): string {
  const seg = URL_SEGMENT[locale];
  return target.channel === "portal" ? `/${seg}/account/checkout?checkout=${target.checkoutId}` : `/${seg}/checkout?checkout=${target.checkoutId}`;
}

// ---------------------------------------------------------------------------
// markCheckoutRecoveryMessage
// ---------------------------------------------------------------------------

/** Rule 51: links the recovery email to the checkout, only while `recovery_message_id` is null. */
export async function markCheckoutRecoveryMessage(tx: Tx, input: { checkoutId: string; emailMessageId: string }): Promise<void> {
  await tx
    .update(checkouts)
    .set({ recoveryMessageId: input.emailMessageId, updatedAt: new Date() })
    .where(and(eq(checkouts.id, input.checkoutId), isNull(checkouts.recoveryMessageId)));
}

// ---------------------------------------------------------------------------
// Attribution (rule 51), run by checkouts.mark_abandoned
// ---------------------------------------------------------------------------

export type AttributeRecoveriesResult = { recovered: number; messagesFilled: number };

/**
 * The first order (by `paid_at`) the person paid within the window after `abandoned_at` that
 * contains one of `productIds`, or null.
 */
async function recoveringOrder(
  tx: DbOrTx,
  input: { personId: string; productIds: string[]; abandonedAt: Date; windowMs: number },
): Promise<{ id: string; paidAt: Date; totalCents: number } | null> {
  if (!input.productIds.length) return null;
  const until = new Date(input.abandonedAt.getTime() + input.windowMs);
  const [row] = await tx
    .selectDistinct({ id: orders.id, paidAt: orders.paidAt, totalCents: orders.totalCents })
    .from(orders)
    .innerJoin(orderLines, eq(orderLines.orderId, orders.id))
    .where(
      and(
        eq(orders.personId, input.personId),
        inArray(orders.status, [...RECOVERED_ORDER_STATUSES]),
        isNotNull(orders.paidAt),
        gte(orders.paidAt, input.abandonedAt),
        lte(orders.paidAt, until),
        inArray(orderLines.productId, input.productIds),
      ),
    )
    .orderBy(asc(orders.paidAt), asc(orders.id))
    .limit(1);
  return row?.paidAt ? { id: row.id, paidAt: row.paidAt, totalCents: row.totalCents } : null;
}

/**
 * Rule 51: attributes recoveries for checkouts abandoned within the window (plus one day, so an
 * order paid just before the window closes is still seen by the next run). Rows are chosen
 * `FOR UPDATE SKIP LOCKED`, 500 per batch; a recovered checkout leaves the scan, so a second run
 * changes nothing.
 */
export async function attributeRecoveries(ctx: JobCtx | Ctx): Promise<AttributeRecoveriesResult> {
  const tx = ctx.tx;
  const now = ctx.now;
  const windowMs = (await commerceSettings(tx)).recovery_window_days * DAY_MS;
  const since = new Date(now.getTime() - windowMs - DAY_MS);
  const out: AttributeRecoveriesResult = { recovered: 0, messagesFilled: 0 };
  let after: { at: Date; id: string } | null = null;

  for (let round = 0; round < 40; round++) {
    const cursor: { at: Date; id: string } | null = after;
    const batch = await tx
      .select({
        id: checkouts.id,
        personId: checkouts.personId,
        items: checkouts.items,
        abandonedAt: checkouts.abandonedAt,
        recoveryMessageId: checkouts.recoveryMessageId,
      })
      .from(checkouts)
      .where(
        and(
          isNotNull(checkouts.abandonedAt),
          gt(checkouts.abandonedAt, since),
          isNull(checkouts.recoveredOrderId),
          isNotNull(checkouts.personId),
          ...(cursor ? [sql`(${checkouts.abandonedAt}, ${checkouts.id}) > (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`] : []),
        ),
      )
      .orderBy(asc(checkouts.abandonedAt), asc(checkouts.id))
      .limit(BATCH)
      .for("update", { skipLocked: true });

    for (const c of batch) {
      const personId = c.personId!;
      const abandonedAt = c.abandonedAt!;
      const productIds = [...new Set(((c.items as CartItem[] | null) ?? []).map((i) => i.productId))];
      const order = await recoveringOrder(tx, { personId, productIds, abandonedAt, windowMs });
      if (!order) continue;
      let recoveryMessageId = c.recoveryMessageId;
      if (!recoveryMessageId) {
        const latest = await findLatestMessage(tx, { personId, templateSlug: RECOVERY_TEMPLATE, after: abandonedAt });
        if (latest) {
          recoveryMessageId = latest.emailMessageId;
          out.messagesFilled++;
        }
      }
      await tx
        .update(checkouts)
        .set({ recoveredOrderId: order.id, recoveredAt: order.paidAt, recoveryMessageId, updatedAt: now })
        .where(eq(checkouts.id, c.id));
      await ctx.recordEvent({
        kind: "checkout.recovered",
        personId,
        ref: { type: "checkout", id: c.id },
        dedupeKey: `checkout:${c.id}:recovered`,
        data: { checkout_id: c.id, order_id: order.id },
      });
      out.recovered++;
    }
    if (batch.length < BATCH) break;
    const last = batch[batch.length - 1]!;
    after = { at: last.abandonedAt!, id: last.id };
  }
  return out;
}

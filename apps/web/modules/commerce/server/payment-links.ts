/**
 * Payment links (commerce spec rules 26a and 41; commerce-P4b; commerce-P6 adds the pay page
 * reads and payment (`getPayOrderByToken`, `payByToken`), `sendPaymentLink` and the job
 * `payments.create_link`, which sends `commerce.payment_link`). A link is the BEAM-hosted page `/[locale]/pay/<token>` for one order. The
 * token is derived, not random: `base64url(HMAC-SHA256(VOUCHER_CODE_SECRET, 'pay:' + order_id +
 * ':' + pay_token_expires_at epoch seconds))`, stored only as sha256 in `pay_token_hash`. Because
 * it can be derived again, `getPayLinkForOrder` returns the same URL to every caller while it is
 * valid (credits' dunning reminders, staff resend) and issues a new expiry, and so a new token,
 * only after it expired.
 */
import { z } from "zod";
import { orderLines, orders, persons } from "@beam/db/schema";
import { derivePayToken, sha256Hex } from "@beam/core/commerce";
import { PermanentError } from "@beam/core/errors";
import { formatDate, formatMoney, pick, URL_SEGMENT, type Locale, type LocalizedText } from "@beam/core/i18n";
import { appUrl } from "@/lib/auth";
import { asc, eq, ConflictError, NotFoundError, ValidationError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import type { JobCtx } from "@/lib/job-runner";
import { sendTransactional } from "@/modules/email/api";
import { getCurrentLegalVersion, recordTermsAcceptance } from "@/modules/site/api";
import { commerceSettings, lockOrder, orderSubject, paidCentsOf, PAID_PAYMENT_STATUSES, type OrderRow } from "./paid";
import { startPayment } from "./payments";

/** The HMAC secret shared with voucher codes (the `pay:` label keeps the two apart). */
function paySecret(): string {
  const secret = process.env.VOUCHER_CODE_SECRET;
  if (!secret) throw new PermanentError("voucher_code_secret_missing");
  return secret;
}

/** The absolute pay page URL of a token in the order's locale. */
export function payPageUrl(token: string, locale: Locale): string {
  return appUrl(`/${URL_SEGMENT[locale]}/pay/${token}`);
}

/** The order a pay token names: its sha256 is looked up in `pay_token_hash` (the pay page, commerce-P6). */
export async function findOrderByPayToken(db: DbOrTx, token: string): Promise<{ orderId: string; expiresAt: Date | null } | null> {
  const [row] = await db
    .select({ id: orders.id, expiresAt: orders.payTokenExpiresAt })
    .from(orders)
    .where(eq(orders.payTokenHash, await sha256Hex(token)));
  return row ? { orderId: row.id, expiresAt: row.expiresAt } : null;
}

/**
 * api `getPayLinkForOrder` (rule 41): the order's pay link, the same URL while
 * `pay_token_expires_at` lies ahead; otherwise a new expiry (`now + pay_link_days`, whole
 * seconds, because the token is derived from the epoch seconds) and so a new token. Runs under
 * the order row lock, so two callers never issue two tokens.
 */
export async function getPayLinkForOrder(tx: Tx, ctx: Ctx, input: { orderId: string }): Promise<{ payUrl: string; expiresAt: Date }> {
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  const secret = paySecret();
  const locale = order.locale as Locale;
  if (order.payTokenExpiresAt && order.payTokenHash && order.payTokenExpiresAt.getTime() > ctx.now.getTime()) {
    const token = await derivePayToken(secret, order.id, order.payTokenExpiresAt);
    return { payUrl: payPageUrl(token, locale), expiresAt: order.payTokenExpiresAt };
  }
  const settings = await commerceSettings(tx);
  const expiresAt = new Date(Math.floor((ctx.now.getTime() + settings.pay_link_days * 86_400_000) / 1000) * 1000);
  const token = await derivePayToken(secret, order.id, expiresAt);
  await tx
    .update(orders)
    .set({ payTokenHash: await sha256Hex(token), payTokenExpiresAt: expiresAt, updatedAt: ctx.now })
    .where(eq(orders.id, order.id));
  return { payUrl: payPageUrl(token, locale), expiresAt };
}

// ---------------------------------------------------------------------------
// Sending a link (staff) and the job payments.create_link (commerce-P6)
// ---------------------------------------------------------------------------

/** `sendPaymentLink` (staff, `commerce.sell`): issues or reuses the link and enqueues `payments.create_link`. */
export async function sendPaymentLink(tx: Tx, ctx: Ctx, input: { orderId: string; email?: string | undefined }): Promise<{ expiresAt: Date; payUrl: string }> {
  const order = await lockOrder(tx, input.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  if (order.status !== "pending_payment") throw new ConflictError("invalid_transition");
  let email = input.email?.trim().toLowerCase() || null;
  if (!email && order.personId) {
    const [p] = await tx.select({ email: persons.email }).from(persons).where(eq(persons.id, order.personId));
    email = p?.email ?? null;
  }
  if (!email) throw new ValidationError("validation", { email: "required" });
  const link = await getPayLinkForOrder(tx, ctx, { orderId: order.id });
  const key = `pay_link:${order.id}:${order.version}`;
  await ctx.enqueue({ kind: "payments.create_link", payload: { orderId: order.id, email, version: order.version }, key });
  const subject = orderSubject(order);
  if (subject) {
    await ctx.recordEvent({ kind: "payment_link.sent", ...subject, ref: { type: "order", id: order.id }, dedupeKey: `${key}:sent`, data: { order_id: order.id } });
  }
  await ctx.audit({
    action: "payment_link.sent",
    entityType: "order",
    entityId: order.id,
    ...(order.personId ? { personId: order.personId } : {}),
    newValue: { expiresAt: link.expiresAt.toISOString(), toOther: !!input.email },
  });
  return link;
}

export const CreatePayLinkInput = z.object({ orderId: z.uuid(), email: z.string().email(), version: z.number().int().min(0).optional() });

export type CreatePayLinkResult = { skipped: true; status: OrderRow["status"] } | { emailMessageId: string; payUrl: string };

/**
 * `payments.create_link` (key `pay_link:<order_id>:<version>`): the order's pay link (the same
 * URL while valid) sent as `commerce.payment_link` with the same key. A paid or ended order sends nothing.
 */
export async function createPayLinkJob(ctx: JobCtx | Ctx, input: z.infer<typeof CreatePayLinkInput>): Promise<CreatePayLinkResult> {
  const tx = ctx.tx;
  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId));
  if (!order) throw new NotFoundError("order_not_found");
  if (order.status !== "pending_payment") return { skipped: true, status: order.status };
  const link = await getPayLinkForOrder(tx, ctx, { orderId: order.id });
  const locale = order.locale as Locale;
  const due = order.totalCents - (await paidCentsOf(tx, order.id));
  const sent = await sendTransactional(ctx, {
    template: "commerce.payment_link",
    ...(order.personId ? { personId: order.personId } : {}),
    to: input.email,
    locale,
    data: { reference: order.reference, amount: formatMoney(Math.max(0, due), locale), payUrl: link.payUrl, validUntil: formatDate(link.expiresAt, locale, "long") },
    key: `pay_link:${order.id}:${input.version ?? order.version}`,
  });
  return { emailMessageId: sent.emailMessageId, payUrl: link.payUrl };
}

// ---------------------------------------------------------------------------
// The pay page (`/[locale]/pay/[token]`)
// ---------------------------------------------------------------------------

export type PayPageState = "payable" | "paid" | "expired" | "cancelled" | "invalid";

export type PayPageView = {
  state: PayPageState;
  orderId: string | null;
  reference: string | null;
  locale: Locale | null;
  lines: { description: string; quantity: number; lineTotalCents: number }[];
  totalCents: number;
  dueCents: number;
  needsTerms: boolean;
  expiresAt: Date | null;
};

const EMPTY: PayPageView = { state: "invalid", orderId: null, reference: null, locale: null, lines: [], totalCents: 0, dueCents: 0, needsTerms: false, expiresAt: null };

/** The state a token opens (rule 41): never a payment form after expiry or payment. */
export function payPageState(order: Pick<OrderRow, "status" | "expiresAt">, tokenExpiresAt: Date | null, now: Date): PayPageState {
  if ((PAID_PAYMENT_STATUSES as readonly string[]).includes(order.status)) return "paid";
  if (order.status === "cancelled") return "cancelled";
  if (order.status === "expired") return "expired";
  if (order.status !== "pending_payment") return "invalid";
  if (!tokenExpiresAt || tokenExpiresAt.getTime() <= now.getTime()) return "expired";
  if (order.expiresAt && order.expiresAt.getTime() <= now.getTime()) return "expired";
  return "payable";
}

/** Link orders always ask for the terms; other orders only when the published version changed (rule 26a). */
async function needsTermsFor(db: DbOrTx, order: Pick<OrderRow, "channel" | "termsVersionId">): Promise<boolean> {
  const terms = await getCurrentLegalVersion(db, "terms");
  if (!terms) return true;
  return order.channel === "link" || order.termsVersionId !== terms.versionId;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

/** `getPayOrderByToken(db, token)`: what the pay page shows for a token. */
export async function getPayOrderByToken(db: DbOrTx, token: string, now: Date = new Date()): Promise<PayPageView> {
  if (!TOKEN_RE.test(token)) return EMPTY;
  const found = await findOrderByPayToken(db, token);
  if (!found) return EMPTY;
  const [order] = await db.select().from(orders).where(eq(orders.id, found.orderId));
  if (!order) return EMPTY;
  const locale = order.locale as Locale;
  const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, order.id)).orderBy(asc(orderLines.lineNo));
  const state = payPageState(order, found.expiresAt, now);
  return {
    state,
    orderId: order.id,
    reference: order.reference,
    locale,
    lines: lines.map((l) => ({ description: pick(l.description as LocalizedText, locale, "order_lines.description") || l.sku, quantity: l.quantity, lineTotalCents: l.lineTotalCents })),
    totalCents: order.totalCents,
    dueCents: Math.max(0, order.totalCents - (await paidCentsOf(db, order.id))),
    needsTerms: state === "payable" ? await needsTermsFor(db, order) : false,
    expiresAt: found.expiresAt,
  };
}

export const PayByTokenInput = z.object({ token: z.string().regex(TOKEN_RE), clientKey: z.uuid(), acceptTerms: z.boolean().optional() });

/**
 * Pays the order a token names (rule 41): only a payable state reaches the provider; a link
 * order records the terms acceptance (rule 26a) in this transaction. The provider returns the
 * customer to the pay page, which shows the paid state.
 */
export async function payByToken(tx: Tx, ctx: Ctx, input: z.infer<typeof PayByTokenInput>): Promise<{ redirectUrl: string; orderId: string }> {
  const found = await findOrderByPayToken(tx, input.token);
  if (!found) throw new NotFoundError("order_not_found");
  const order = await lockOrder(tx, found.orderId);
  if (!order) throw new NotFoundError("order_not_found");
  const state = payPageState(order, found.expiresAt, ctx.now);
  if (state === "paid") return { redirectUrl: payPageUrl(input.token, order.locale as Locale), orderId: order.id };
  if (state === "expired") throw new ConflictError("order_expired");
  if (state !== "payable") throw new ConflictError("invalid_transition");
  if (await needsTermsFor(tx, order)) {
    const terms = await getCurrentLegalVersion(tx, "terms");
    if (!terms) throw new ConflictError("terms_unavailable");
    if (!input.acceptTerms) throw new ValidationError("validation", { acceptTerms: "required" });
    if (order.personId) {
      await recordTermsAcceptance(tx, ctx, { personId: order.personId, versionId: terms.versionId, context: "checkout", refType: "order", refId: order.id, ip: ctx.ip });
    }
    await tx.update(orders).set({ termsVersionId: terms.versionId, updatedAt: ctx.now }).where(eq(orders.id, order.id));
  }
  const { redirectUrl } = await startPayment(tx, ctx, { orderId: order.id, returnPath: `/pay/${input.token}` });
  return { redirectUrl, orderId: order.id };
}

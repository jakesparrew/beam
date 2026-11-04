/**
 * Payment links (commerce spec rule 41; commerce-P4b; commerce-P6 adds the pay page and
 * `sendPaymentLink`). A link is the BEAM-hosted page `/[locale]/pay/<token>` for one order. The
 * token is derived, not random: `base64url(HMAC-SHA256(VOUCHER_CODE_SECRET, 'pay:' + order_id +
 * ':' + pay_token_expires_at epoch seconds))`, stored only as sha256 in `pay_token_hash`. Because
 * it can be derived again, `getPayLinkForOrder` returns the same URL to every caller while it is
 * valid (credits' dunning reminders, staff resend) and issues a new expiry, and so a new token,
 * only after it expired.
 */
import { orders } from "@beam/db/schema";
import { derivePayToken, sha256Hex } from "@beam/core/commerce";
import { PermanentError } from "@beam/core/errors";
import { URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { appUrl } from "@/lib/auth";
import { eq, NotFoundError, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { commerceSettings, lockOrder } from "./paid";

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

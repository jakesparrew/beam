/**
 * commerce's transactional templates (commerce spec section 6). Registry keys and
 * `email_templates.slug` values `commerce.<name>`, `<name>` the file basename with `-` replaced by
 * `_`. commerce-P4a: `commerce.order_confirmation`, `commerce.payment_failed`,
 * `commerce.portal_invitation`; commerce-P6: `commerce.payment_link`, `commerce.gift_voucher`,
 * `commerce.refund_confirmation`; commerce-P7: `commerce.pos_receipt`; commerce-P8 (R2):
 * `commerce.checkout_recovery`, which automation sends without `data` (`loadProps`, rule 39a,
 * cross-module D54). Copy lives in the `commerce` catalogue under `commerce.email.<name>.*`.
 *
 * `loadProps` reads the checkout through the caller's transaction with one query; `@beam/email`
 * cannot import `@beam/db` (architecture section 1), so it uses the transaction's `execute()`
 * with a plain SQL string whose only inputs are UUIDs and a locale validated here.
 */
import { formatMoney, isLocale, LOCALES, type Locale } from "@beam/core/i18n";
import { defineTemplate, type LoadPropsArgs } from "../define";
import { CheckoutRecovery, CheckoutRecoveryProps, checkoutRecoverySample, recoveryVariant } from "./checkout-recovery";
import { OrderConfirmation, OrderConfirmationProps, orderConfirmationSample } from "./order-confirmation";
import { PaymentFailed, PaymentFailedProps, paymentFailedSample } from "./payment-failed";
import { PortalInvitation, PortalInvitationProps, portalInvitationSample } from "./portal-invitation";
import { GiftVoucher, GiftVoucherProps, giftVoucherSample } from "./gift-voucher";
import { PaymentLink, PaymentLinkProps, paymentLinkSample } from "./payment-link";
import { RefundConfirmation, RefundConfirmationProps, refundConfirmationSample } from "./refund-confirmation";
import { PosReceipt, PosReceiptProps, posReceiptSample } from "./pos-receipt";

export { CheckoutRecoveryProps, GiftVoucherProps, OrderConfirmationProps, PaymentFailedProps, PaymentLinkProps, PortalInvitationProps, PosReceiptProps, RefundConfirmationProps };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Executor = { execute(query: string): Promise<unknown> };

const rowsOf = (result: unknown): Array<Record<string, unknown>> =>
  Array.isArray(result) ? (result as Array<Record<string, unknown>>) : (((result as { rows?: unknown[] } | null)?.rows ?? []) as Array<Record<string, unknown>>);

/** A localized product name in `locale`, else any filled locale, else the SKU. */
function nameIn(name: unknown, sku: string, locale: Locale): string {
  const text = (typeof name === "string" ? JSON.parse(name) : (name ?? {})) as Partial<Record<Locale, string>>;
  for (const l of [locale, ...LOCALES]) {
    const v = text[l]?.trim();
    if (v) return v;
  }
  return sku;
}

/**
 * The props of `commerce.checkout_recovery` for the checkout of `context.checkout_id`, when it
 * belongs to `personId` (or to a person merged into it). Throws otherwise, so email stores no
 * props and the send fails with `invalid_template_data`.
 */
export async function loadCheckoutRecoveryProps(tx: unknown, args: LoadPropsArgs): Promise<CheckoutRecoveryProps> {
  const checkoutId = args.context.checkout_id ?? "";
  const personId = args.personId ?? "";
  const resumeUrl = args.context.resume_url ?? "";
  if (!UUID.test(checkoutId)) throw new Error("commerce.checkout_recovery: context.checkout_id is missing or not a uuid");
  if (!UUID.test(personId)) throw new Error("commerce.checkout_recovery: personId is not a uuid");
  if (!/^https?:\/\//.test(resumeUrl)) throw new Error("commerce.checkout_recovery: context.resume_url is missing");
  if (!isLocale(args.locale)) throw new Error("commerce.checkout_recovery: unknown locale");
  const db = tx as Executor;
  if (typeof db?.execute !== "function") throw new Error("commerce.checkout_recovery: loadProps needs a transaction");
  const rows = rowsOf(
    await db.execute(`select c.id::text as checkout_id, c.total_cents, i.ord, p.sku, p.name,
        case when jsonb_typeof(i.value->'quantity') = 'number' then (i.value->>'quantity')::int else 1 end as quantity
      from checkouts c
      cross join lateral jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) with ordinality as i(value, ord)
      join products p on p.id::text = i.value->>'productId'
      where c.id = '${checkoutId}'::uuid
        and (c.person_id = '${personId}'::uuid
             or c.person_id in (select id from persons where merged_into_person_id = '${personId}'::uuid))
      order by i.ord`),
  );
  if (!rows.length) throw new Error("commerce.checkout_recovery: checkout not found for this person");
  const items = rows.map((r) => ({ name: nameIn(r.name, String(r.sku), args.locale), quantity: Math.max(1, Number(r.quantity)) }));
  const totalCents = rows[0]!.total_cents === null || rows[0]!.total_cents === undefined ? 0 : Number(rows[0]!.total_cents);
  return {
    variant: recoveryVariant(args.stepKey),
    items,
    total: formatMoney(Math.round(totalCents), args.locale),
    resumeUrl,
    checkoutId: String(rows[0]!.checkout_id),
  };
}

const slots = (name: string) => ({
  subject: `commerce.email.${name}.subject`,
  preheader: `commerce.email.${name}.preheader`,
  heading: `commerce.email.${name}.heading`,
  body: `commerce.email.${name}.body`,
  cta: `commerce.email.${name}.cta`,
});

export const templates = [
  defineTemplate({
    name: "order_confirmation",
    component: OrderConfirmation,
    props: OrderConfirmationProps,
    sample: orderConfirmationSample,
    slots: slots("order_confirmation"),
  }),
  defineTemplate({ name: "payment_failed", component: PaymentFailed, props: PaymentFailedProps, sample: paymentFailedSample, slots: slots("payment_failed") }),
  defineTemplate({
    name: "portal_invitation",
    component: PortalInvitation,
    props: PortalInvitationProps,
    sample: portalInvitationSample,
    slots: slots("portal_invitation"),
  }),
  defineTemplate({ name: "payment_link", component: PaymentLink, props: PaymentLinkProps, sample: paymentLinkSample, slots: slots("payment_link") }),
  defineTemplate({
    name: "refund_confirmation",
    component: RefundConfirmation,
    props: RefundConfirmationProps,
    sample: refundConfirmationSample,
    slots: slots("refund_confirmation"),
  }),
  defineTemplate({ name: "pos_receipt", component: PosReceipt, props: PosReceiptProps, sample: posReceiptSample, slots: slots("pos_receipt") }),
  defineTemplate({ name: "gift_voucher", component: GiftVoucher, props: GiftVoucherProps, sample: giftVoucherSample, slots: slots("gift_voucher") }),
  defineTemplate({
    name: "checkout_recovery",
    component: CheckoutRecovery,
    props: CheckoutRecoveryProps,
    sample: checkoutRecoverySample,
    slots: { ...slots("checkout_recovery"), prices: "commerce.email.checkout_recovery.prices" },
    loadProps: loadCheckoutRecoveryProps,
  }),
];

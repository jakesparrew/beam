/**
 * commerce's transactional templates (commerce spec section 6). Registry keys and
 * `email_templates.slug` values `commerce.<name>`, `<name>` the file basename with `-` replaced by
 * `_`. commerce-P4a: `commerce.order_confirmation`, `commerce.payment_failed`,
 * `commerce.portal_invitation`; commerce-P6: `commerce.payment_link`, `commerce.gift_voucher`,
 * `commerce.refund_confirmation`; commerce-P7: `commerce.pos_receipt`; R2
 * `commerce.checkout_recovery` joins with its package. Copy lives in the `commerce` catalogue under `commerce.email.<name>.*`.
 */
import { defineTemplate } from "../define";
import { OrderConfirmation, OrderConfirmationProps, orderConfirmationSample } from "./order-confirmation";
import { PaymentFailed, PaymentFailedProps, paymentFailedSample } from "./payment-failed";
import { PortalInvitation, PortalInvitationProps, portalInvitationSample } from "./portal-invitation";
import { GiftVoucher, GiftVoucherProps, giftVoucherSample } from "./gift-voucher";
import { PaymentLink, PaymentLinkProps, paymentLinkSample } from "./payment-link";
import { RefundConfirmation, RefundConfirmationProps, refundConfirmationSample } from "./refund-confirmation";
import { PosReceipt, PosReceiptProps, posReceiptSample } from "./pos-receipt";

export { GiftVoucherProps, OrderConfirmationProps, PaymentFailedProps, PaymentLinkProps, PortalInvitationProps, PosReceiptProps, RefundConfirmationProps };

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
];

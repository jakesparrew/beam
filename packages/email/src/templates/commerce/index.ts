/**
 * commerce's transactional templates (commerce spec section 6). Registry keys and
 * `email_templates.slug` values `commerce.<name>`, `<name>` the file basename with `-` replaced by
 * `_`. commerce-P4a: `commerce.order_confirmation`, `commerce.payment_failed`,
 * `commerce.portal_invitation`; `commerce.pos_receipt`, `commerce.payment_link`,
 * `commerce.gift_voucher`, `commerce.refund_confirmation` and R2 `commerce.checkout_recovery` join
 * with their packages. Copy lives in the `commerce` catalogue under `commerce.email.<name>.*`.
 */
import { defineTemplate } from "../define";
import { OrderConfirmation, OrderConfirmationProps, orderConfirmationSample } from "./order-confirmation";
import { PaymentFailed, PaymentFailedProps, paymentFailedSample } from "./payment-failed";
import { PortalInvitation, PortalInvitationProps, portalInvitationSample } from "./portal-invitation";

export { OrderConfirmationProps, PaymentFailedProps, PortalInvitationProps };

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
];

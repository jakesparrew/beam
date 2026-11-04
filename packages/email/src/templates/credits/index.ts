/**
 * credits' transactional templates (credits spec section 8). Registry keys and
 * `email_templates.slug` values: `credits.membership_started`, `credits.membership_renewal_reminder`,
 * `credits.membership_renewed`, `credits.membership_payment_failed`, `credits.membership_expired`,
 * `credits.membership_cancel_confirmed` (credits-P4); `credits.share_invitation` (R2, credits-P8)
 * and `credits.referral_reward` (R3, credits-P9) join with their packages. Copy lives in the
 * `credits` catalogue under `credits.email.<snake_name>.*`.
 */
import { defineTemplate } from "../define";
import { MembershipCancelConfirmed, membershipCancelConfirmedSample, MembershipCancelConfirmedProps } from "./membership-cancel-confirmed";
import { MembershipExpired, membershipExpiredSample, MembershipExpiredProps } from "./membership-expired";
import { MembershipPaymentFailed, membershipPaymentFailedSample, MembershipPaymentFailedProps } from "./membership-payment-failed";
import { MembershipRenewalReminder, membershipRenewalReminderSample, MembershipRenewalReminderProps } from "./membership-renewal-reminder";
import { MembershipRenewed, membershipRenewedSample, MembershipRenewedProps } from "./membership-renewed";
import { MembershipStarted, membershipStartedSample, MembershipStartedProps } from "./membership-started";
import { ShareInvitation, shareInvitationSample, ShareInvitationProps } from "./share-invitation";

const slots = (name: string) => ({
  subject: `credits.email.${name}.subject`,
  preheader: `credits.email.${name}.preheader`,
  heading: `credits.email.${name}.heading`,
  body: `credits.email.${name}.body`,
  cta: `credits.email.${name}.cta`,
});

export const templates = [
  defineTemplate({ name: "membership_started", component: MembershipStarted, props: MembershipStartedProps, sample: membershipStartedSample, slots: slots("membership_started") }),
  defineTemplate({
    name: "membership_renewal_reminder",
    component: MembershipRenewalReminder,
    props: MembershipRenewalReminderProps,
    sample: membershipRenewalReminderSample,
    slots: slots("membership_renewal_reminder"),
  }),
  defineTemplate({ name: "membership_renewed", component: MembershipRenewed, props: MembershipRenewedProps, sample: membershipRenewedSample, slots: slots("membership_renewed") }),
  defineTemplate({
    name: "membership_payment_failed",
    component: MembershipPaymentFailed,
    props: MembershipPaymentFailedProps,
    sample: membershipPaymentFailedSample,
    slots: slots("membership_payment_failed"),
  }),
  defineTemplate({ name: "membership_expired", component: MembershipExpired, props: MembershipExpiredProps, sample: membershipExpiredSample, slots: slots("membership_expired") }),
  defineTemplate({
    name: "membership_cancel_confirmed",
    component: MembershipCancelConfirmed,
    props: MembershipCancelConfirmedProps,
    sample: membershipCancelConfirmedSample,
    slots: slots("membership_cancel_confirmed"),
  }),
  defineTemplate({ name: "share_invitation", component: ShareInvitation, props: ShareInvitationProps, sample: shareInvitationSample, slots: slots("share_invitation") }),
];

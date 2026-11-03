/**
 * Platform's transactional templates (platform spec section 8). Registry keys and
 * `email_templates.slug` values: `platform.magic_link`, `platform.staff_invite`,
 * `platform.password_reset`, `platform.mfa_changed`, `platform.monthly_report`.
 */
import { defineTemplate } from "../define";
import { MagicLink, MagicLinkProps } from "./magic-link";
import { MfaChanged, MfaChangedProps } from "./mfa-changed";
import { MonthlyReport, MonthlyReportProps } from "./monthly-report";
import { PasswordReset, PasswordResetProps } from "./password-reset";
import { StaffInvite, StaffInviteProps } from "./staff-invite";

const slots = (name: string) => ({
  subject: `platform.email.${name}.subject`,
  preheader: `platform.email.${name}.preheader`,
  heading: `platform.email.${name}.heading`,
  body: `platform.email.${name}.body`,
  cta: `platform.email.${name}.cta`,
});

export const templates = [
  defineTemplate({ name: "magic_link", component: MagicLink, props: MagicLinkProps, slots: slots("magic_link") }),
  defineTemplate({ name: "staff_invite", component: StaffInvite, props: StaffInviteProps, slots: slots("staff_invite") }),
  defineTemplate({ name: "password_reset", component: PasswordReset, props: PasswordResetProps, slots: slots("password_reset") }),
  defineTemplate({ name: "mfa_changed", component: MfaChanged, props: MfaChangedProps, slots: slots("mfa_changed") }),
  defineTemplate({ name: "monthly_report", component: MonthlyReport, props: MonthlyReportProps, slots: slots("monthly_report") }),
];

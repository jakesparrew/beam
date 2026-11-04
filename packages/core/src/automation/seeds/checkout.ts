/**
 * `abandoned-checkout` (spec 3.6, commerce rules 51 and 52, cross-module D54; R2 draft): a
 * marketing journey (purpose `newsletter`, group `checkout`) that runs only while commerce's
 * `ff_commerce_checkout_recovery` is on (A-11a). Both reminders send commerce's registry template
 * `commerce.checkout_recovery` as a marketing message (`send_as: 'marketing'`, A-31); the resume
 * URL comes from `commerce.getCheckoutRecoveryProps` (A-31a). A high-value cart adds a sales task.
 * This module seeds no template for it: the system row belongs to commerce's registry template.
 */
import { DAY, definition, fromEnrolment, HOUR, type SeedAutomation } from "./groups";

export const CHECKOUT_RECOVERY_TEMPLATE = "commerce.checkout_recovery";
/** Carts of at least EUR 300 get a sales task. */
export const HIGH_VALUE_CENTS = 30_000;

export const CHECKOUT_SEEDS: SeedAutomation[] = [
  {
    slug: "abandoned-checkout",
    name: "Abandoned checkout",
    description: "Recovery reminders after 1 hour and 24 hours, and a sales task for a high-value cart (Release 2).",
    groupKey: "checkout",
    priority: 100,
    isMarketing: true,
    purpose: "newsletter",
    status: "draft",
    requiresDpia: null,
    requiresFlag: "ff_commerce_checkout_recovery",
    release: "R2",
    definition: definition({
      trigger: { event: "checkout.abandoned" },
      anchor: "enrolment",
      subject: "ref",
      re_entry: "after_days:7",
      exit_on: ["order.paid", { event: "checkout.completed", same_subject: true }, { event: "checkout.recovered", same_subject: true }],
      steps: [
        { key: "remind_1h", type: "email", template: CHECKOUT_RECOVERY_TEMPLATE, send_as: "marketing", at: fromEnrolment(HOUR) },
        { key: "remind_24h", type: "email", template: CHECKOUT_RECOVERY_TEMPLATE, send_as: "marketing", at: fromEnrolment(DAY) },
        { key: "high_value", type: "condition", if: { trigger: { "data.total_cents": { gte: HIGH_VALUE_CENTS } } }, then: "high_value_task", else: "end" },
        { key: "high_value_task", type: "task", title: "Verlaten winkelmand met hoge waarde: bel klant", kind: "call", owner_role: "sales", due_in_minutes: DAY, priority: "high", at: fromEnrolment(2 * DAY) },
      ],
    }),
    templates: [],
  },
];

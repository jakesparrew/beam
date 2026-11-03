/**
 * commerce settings and flags (02-data-model 5.4 and 5.5). Facade read by `pnpm gen:indexes`.
 * Wave 0 by platform-P7; commerce owns it from commerce-P1 on and may tighten the schemas.
 */
import { z } from "zod";
import { defineSetting } from "@/lib/settings";

const days = z.number().int().positive();

export const CommerceSettings = z.object({
  order_expiry_minutes: z.number().int().positive(),
  checkout_abandon_minutes: z.number().int().positive(),
  checkout_expiry_days: days,
  recovery_window_days: days,
  pay_link_days: days,
  bank_transfer_due_days: days,
  draft_expiry_days: days,
  max_voucher_attempts_per_hour: z.number().int().positive(),
  refund_second_permission_above_cents: z.number().int().nonnegative(),
  refund_second_permission_after_days: days,
  withdrawal_days: days,
  voucher_expiry_warning_days: days,
  pos_cash_float_cents: z.number().int().nonnegative(),
  pos_terminals: z.array(z.object({ id: z.string(), name: z.string() })),
  receipt_footer: z.partialRecord(z.enum(["nl-BE", "fr-BE", "en"]), z.string()),
});

const provider = z.enum(["mollie"]);
export const PaymentProviderByChannel = z.object({
  portal: provider,
  site: provider,
  admin: provider,
  pos: provider,
  link: provider,
  recurring: provider,
});

export const settings = [
  defineSetting({
    key: "commerce",
    schema: CommerceSettings,
    default: {
      order_expiry_minutes: 30,
      checkout_abandon_minutes: 60,
      checkout_expiry_days: 30,
      recovery_window_days: 7,
      pay_link_days: 14,
      bank_transfer_due_days: 14,
      draft_expiry_days: 30,
      max_voucher_attempts_per_hour: 5,
      refund_second_permission_above_cents: 50_000,
      refund_second_permission_after_days: 365,
      withdrawal_days: 14,
      voucher_expiry_warning_days: 30,
      pos_cash_float_cents: 15_000,
      pos_terminals: [],
      receipt_footer: {},
    },
    description: "Order expiry, checkout recovery, payment links, refunds, vouchers and POS",
  }),
  defineSetting({
    key: "payment_provider_by_channel",
    schema: PaymentProviderByChannel,
    default: { portal: "mollie", site: "mollie", admin: "mollie", pos: "mollie", link: "mollie", recurring: "mollie" },
    description: "Payment provider per order channel",
  }),
] as const;

export const flags = [{ key: "ff_commerce_checkout_recovery", description: "Abandoned-checkout recovery journey (R2)" }] as const;

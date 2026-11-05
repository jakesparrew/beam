/**
 * commerce settings and flags (02-data-model 5.4 and 5.5, commerce spec section 2.4). Facade read
 * by `pnpm gen:indexes`. The schemas and defaults live in `@beam/core/commerce` (commerce-P1), so
 * the settings register, the seed and the pure core agree on one shape (Convention 3). Staff edit
 * both keys only through platform's `updateSetting`; commerce never writes them.
 * `payment_provider_by_channel` refuses Stripe or Viva for a channel while their keys are absent
 * (`unconfiguredChannels`, commerce-P2): the editor rejects the value, and a stored value that
 * no longer passes reads as the default (Mollie).
 */
import {
  COMMERCE_SETTINGS_DEFAULTS,
  CommerceSettings,
  PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS,
  PaymentProviderByChannel,
} from "@beam/core/commerce";
import { unconfiguredChannels } from "@beam/integrations/payments";
import { defineSetting } from "@/lib/settings";

/** `PaymentProviderByChannel` plus the environment check: no channel on a provider without keys. */
export const PaymentProviderByChannelSetting = PaymentProviderByChannel.superRefine((value, ctx) => {
  for (const channel of unconfiguredChannels(value, process.env)) {
    ctx.addIssue({ code: "custom", path: [channel], message: "provider_not_configured" });
  }
});

export const settings = [
  defineSetting({
    key: "commerce",
    schema: CommerceSettings,
    default: COMMERCE_SETTINGS_DEFAULTS,
    description: "Order expiry, checkout recovery, payment links, refunds, vouchers and POS",
  }),
  defineSetting({
    key: "payment_provider_by_channel",
    schema: PaymentProviderByChannelSetting,
    default: PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS,
    description: "Payment provider per order channel",
  }),
] as const;

export const flags = [{ key: "ff_commerce_checkout_recovery", description: "Abandoned-checkout recovery journey (R2)" }] as const;

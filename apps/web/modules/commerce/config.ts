/**
 * commerce settings and flags (02-data-model 5.4 and 5.5, commerce spec section 2.4). Facade read
 * by `pnpm gen:indexes`. The schemas and defaults live in `@beam/core/commerce` (commerce-P1), so
 * the settings register, the seed and the pure core agree on one shape (Convention 3). Staff edit
 * both keys only through platform's `updateSetting`; commerce never writes them.
 */
import {
  COMMERCE_SETTINGS_DEFAULTS,
  CommerceSettings,
  PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS,
  PaymentProviderByChannel,
} from "@beam/core/commerce";
import { defineSetting } from "@/lib/settings";

export const settings = [
  defineSetting({
    key: "commerce",
    schema: CommerceSettings,
    default: COMMERCE_SETTINGS_DEFAULTS,
    description: "Order expiry, checkout recovery, payment links, refunds, vouchers and POS",
  }),
  defineSetting({
    key: "payment_provider_by_channel",
    schema: PaymentProviderByChannel,
    default: PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS,
    description: "Payment provider per order channel",
  }),
] as const;

export const flags = [{ key: "ff_commerce_checkout_recovery", description: "Abandoned-checkout recovery journey (R2)" }] as const;

/**
 * commerce's GDPR registration (architecture section 11, ops rule 62). Facade read by
 * `pnpm gen:indexes`. Wave 0 skeleton by platform-P7: `tables` lists the module's contract
 * tables that reference a person. commerce-P1 registers every commerce table with a
 * `persons.id` foreign key, plus `order_lines` (read with its order) (OD-9); a later commerce
 * package implements `export` and `erase`.
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration } from "@beam/core/privacy";

export const privacy: PrivacyRegistration<Tx> = {
  tables: [
    "orders",
    "order_lines",
    "person_prices",
    "promotion_redemptions",
    "checkouts",
    "mandates",
    "provider_customers",
    "vouchers",
  ],
  export: () => Promise.resolve({}),
  erase: () => Promise.resolve([]),
};

/**
 * credits's GDPR registration (architecture section 11, ops rule 62). Facade read by
 * `pnpm gen:indexes`. Wave 0 skeleton by platform-P7: `tables` lists the module's contract
 * tables that reference a person. credits-P1 registers every credits table that references a
 * person (OD-9); credits-P5 implements `export` and `erase`.
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration } from "@beam/core/privacy";

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["credit_grants", "credit_entries", "memberships", "membership_periods", "package_shares"],
  export: () => Promise.resolve({}),
  erase: () => Promise.resolve([]),
};

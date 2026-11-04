/**
 * booking's GDPR registration (architecture section 11, ops rule 62). Facade read by
 * `pnpm gen:indexes`. Wave 0 skeleton by platform-P7: `tables` lists the module's tables that
 * reference a person (`waitlist_entries` added with its `persons` FK by fix-w05-schema-1); booking
 * implements `export` and `erase` with its tables in Wave 1.
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration } from "@beam/core/privacy";

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["bookings", "waitlist_entries"],
  export: () => Promise.resolve({}),
  erase: () => Promise.resolve([]),
};

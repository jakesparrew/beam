/**
 * ops's GDPR registration (architecture section 11, ops rule 62). Facade read by
 * `pnpm gen:indexes`. Wave 0 skeleton by platform-P7: `tables` lists the module's contract
 * tables that reference a person; ops implements `export` and `erase` with its tables in Wave 1.
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration } from "@beam/core/privacy";

export const privacy: PrivacyRegistration<Tx> = { tables: [], export: () => Promise.resolve({}), erase: () => Promise.resolve([]) };

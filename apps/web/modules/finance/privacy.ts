/**
 * finance's GDPR registration (finance spec section 9, architecture section 11, ops rule 62).
 * Facade read by `pnpm gen:indexes`. finance-P1 registers every finance table that holds a
 * person reference or personal data, and the tables without any. `export`, `erase` and the
 * four `sweep` handlers (`finance.invoices`, `finance.invoice_requests`,
 * `finance.billit_reconcile_runs`, `finance.finance_exports`) are implemented by finance-P6;
 * until then they report nothing, as in Wave 0. finance passes no `retention`: ops seeds the
 * finance retention rows (cross-module D37).
 */
import type { Tx } from "@beam/db";
import type { PrivacyRegistration } from "@beam/core/privacy";

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["invoices", "order_billing_details", "invoice_requests", "billit_parties"],
  export: () => Promise.resolve({}),
  erase: () => Promise.resolve([]),
};

/** finance tables that hold no person data (finance spec section 9). */
export const noPiiTables = ["invoice_sequences", "billit_reconcile_runs", "finance_exports"] as const;

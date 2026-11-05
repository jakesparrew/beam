/**
 * The finance views ops may expose in the read-only `ai` schema for NL questions (finance spec
 * section 12, finance-P10). Each is an aggregate per day or month without any person column, any
 * contact field, the customer snapshot or a `SENSITIVE_COLUMNS` member (`ai-views.test.ts`).
 * `v_finance_open_invoices` is left out because it carries customer names; `invoices` and
 * `v_finance_invoice_lines` are left out because they are per document.
 */
export const FINANCE_AI_VIEWS = ["v_finance_revenue_daily", "v_finance_vat_summary", "v_finance_failed_payments", "v_finance_recurring_monthly"] as const;

export type FinanceAiView = (typeof FINANCE_AI_VIEWS)[number];

/** One line per view for the schema description ops gives the model (English, as the SQL). */
export const FINANCE_AI_VIEW_DESCRIPTIONS: Record<FinanceAiView, string> = {
  v_finance_revenue_daily:
    "Invoice-based revenue per Brussels issue day, document kind (invoice or credit_note), product category, payment method and VAT rate; credit notes are negative; category 'voucher' is a liability, not revenue; amounts in euro cents (net, vat, gross).",
  v_finance_vat_summary: "VAT per month, quarter, fiscal year, document kind and VAT rate; net, VAT and gross in euro cents; credit notes are negative.",
  v_finance_failed_payments: "Failed and expired payments per Brussels day of the failure, provider and method: count and amount in euro cents; past_due_memberships is the number of memberships past due now.",
  v_finance_recurring_monthly: "Documents of membership renewal orders per month: invoice count, net and gross in euro cents; active_memberships is the number of active memberships now.",
};

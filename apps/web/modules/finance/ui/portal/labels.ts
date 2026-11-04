/**
 * Portal labels of finance (`finance.portal.*`, `finance.billing.*`, `finance.errors.*`): the
 * server page resolves them with `translator(locale)` and hands the strings to the client
 * components (client components have no catalogue).
 */
import type { MyInvoiceRow } from "../../queries";

export type PortalLabels = Record<string, string>;
type Tr = (key: string, params?: Record<string, string | number>) => string;

const REQUEST_KEYS = ["submit", "submitting", "sent", "cancel", "cancelling", "cancelled_done", "error", "field_invalid", "check_fields", "required_mark"] as const;
const BILLING_KEYS = [
  "legal_name",
  "vat_number",
  "vat_number_hint",
  "address_line1",
  "address_line2",
  "postal_code",
  "city",
  "country",
  "billing_email",
  "purchase_order_ref",
  "vat_number_required",
  "vat_number_format",
  "vat_number_checksum",
] as const;
const ERROR_KEYS = ["request_window_closed", "request_pending", "invalid_transition", "invoice_not_found", "request_not_found", "billing_invalid", "not_found"] as const;

/** The strings the request form and the cancel button show. */
export function requestLabels(tr: Tr): PortalLabels {
  const out: PortalLabels = {};
  for (const k of REQUEST_KEYS) out[`request.${k}`] = tr(`finance.portal.request.${k}`);
  for (const k of BILLING_KEYS) out[`billing.${k}`] = tr(`finance.billing.${k}`);
  for (const k of ERROR_KEYS) out[`errors.${k}`] = tr(`finance.errors.${k}`);
  return out;
}

/** The status text of a document (a paid credit note reads "Refunded"). */
export function statusLabel(tr: Tr, doc: Pick<MyInvoiceRow, "kind" | "status">): string {
  if (doc.kind === "credit_note" && doc.status === "paid") return tr("finance.portal.status.credit_note_paid");
  return tr(`finance.portal.status.${doc.status}`);
}

/** The payment method in words; an unknown method is shown as stored. */
export function methodLabel(tr: Tr, method: string): string {
  return (METHODS as readonly string[]).includes(method) ? tr(`finance.portal.method.${method}`) : method;
}

const METHODS = ["bancontact", "creditcard", "terminal", "cash", "bank_transfer", "voucher", "mixed"] as const;

/** The text of an action error: a known `finance.*` message key, else the generic one. */
export function portalErrorText(labels: PortalLabels, error: { code: string; message: string; fields?: Record<string, string> }): string {
  const lookup = (key: string | undefined) => {
    if (!key) return undefined;
    if (key.startsWith("finance.errors.")) return labels[`errors.${key.slice("finance.errors.".length)}`];
    if (key.startsWith("finance.billing.")) return labels[`billing.${key.slice("finance.billing.".length)}`];
    return undefined;
  };
  const own = lookup(error.message);
  if (own) return own;
  for (const v of Object.values(error.fields ?? {})) {
    const t = lookup(v);
    if (t) return t;
  }
  if (error.code === "validation") return labels["request.check_fields"] ?? error.message;
  return labels["request.error"] ?? error.message;
}

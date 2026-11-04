/**
 * The status transitions of invoices and credit notes (finance section 2.1). These are the only
 * transitions `updateInvoiceState()` accepts; anything else throws `InvalidTransitionError`
 * (mapped to `conflict`). A repeated transition to the current status is a no-op, so jobs stay
 * idempotent. `paid` and `cancelled` invoices and `paid` credit notes are terminal.
 */
import type { InvoiceKind, InvoiceStatus } from "./types";

/** `[kind, from, to]`; `from = null` is a new document. */
export const INVOICE_TRANSITIONS: readonly (readonly [InvoiceKind, InvoiceStatus | null, InvoiceStatus])[] = [
  ["invoice", null, "paid"],
  ["invoice", null, "open"],
  ["invoice", "open", "paid"],
  ["invoice", "open", "cancelled"],
  ["invoice", "paid", "cancelled"],
  ["credit_note", null, "issued"],
  ["credit_note", "issued", "paid"],
];

export class InvalidTransitionError extends Error {
  override readonly name: string = "InvalidTransitionError";
  readonly code = "conflict" as const;
  readonly kind: InvoiceKind;
  readonly from: InvoiceStatus | null;
  readonly to: InvoiceStatus;
  constructor(kind: InvoiceKind, from: InvoiceStatus | null, to: InvoiceStatus) {
    super("finance.errors.invalid_transition");
    this.kind = kind;
    this.from = from;
    this.to = to;
  }
}

export function isAllowedTransition(kind: InvoiceKind, from: InvoiceStatus | null, to: InvoiceStatus): boolean {
  return INVOICE_TRANSITIONS.some(([k, f, t]) => k === kind && f === from && t === to);
}

/** The status after the transition; `from === to` is a no-op. Throws `InvalidTransitionError` otherwise. */
export function nextInvoiceStatus(kind: InvoiceKind, from: InvoiceStatus | null, to: InvoiceStatus): InvoiceStatus {
  if (from !== null && from === to && INVOICE_TRANSITIONS.some(([k, , t]) => k === kind && t === to)) return to;
  if (!isAllowedTransition(kind, from, to)) throw new InvalidTransitionError(kind, from, to);
  return to;
}

/** True when no transition leaves `status` for this kind. */
export function isTerminalStatus(kind: InvoiceKind, status: InvoiceStatus): boolean {
  return !INVOICE_TRANSITIONS.some(([k, f]) => k === kind && f === status);
}

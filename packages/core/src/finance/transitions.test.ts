import { describe, expect, it } from "vitest";
import { INVOICE_TRANSITIONS, InvalidTransitionError, isAllowedTransition, isTerminalStatus, nextInvoiceStatus } from "./transitions";
import { INVOICE_KINDS, INVOICE_STATUSES, type InvoiceKind, type InvoiceStatus } from "./types";

/** The table of finance spec section 2.1, written out independently of the code. */
const TABLE: [InvoiceKind, InvoiceStatus | null, InvoiceStatus][] = [
  ["invoice", null, "paid"],
  ["invoice", null, "open"],
  ["invoice", "open", "paid"],
  ["invoice", "open", "cancelled"],
  ["invoice", "paid", "cancelled"],
  ["credit_note", null, "issued"],
  ["credit_note", "issued", "paid"],
];

const key = (k: string, f: string | null, t: string) => `${k}:${f ?? "new"}->${t}`;

describe("nextInvoiceStatus", () => {
  it("accepts every row of the 2.1 table", () => {
    expect(INVOICE_TRANSITIONS.map(([k, f, t]) => key(k, f, t)).sort()).toEqual(TABLE.map(([k, f, t]) => key(k, f, t)).sort());
    for (const [kind, from, to] of TABLE) {
      expect(nextInvoiceStatus(kind, from, to)).toBe(to);
      expect(isAllowedTransition(kind, from, to)).toBe(true);
    }
  });

  it("refuses every other pair with InvalidTransitionError (conflict)", () => {
    const allowed = new Set(TABLE.map(([k, f, t]) => key(k, f, t)));
    const reachable = (k: InvoiceKind, s: InvoiceStatus) => TABLE.some(([tk, , tt]) => tk === k && tt === s);
    let refused = 0;
    for (const kind of INVOICE_KINDS) {
      for (const from of [null, ...INVOICE_STATUSES]) {
        for (const to of INVOICE_STATUSES) {
          if (allowed.has(key(kind, from, to))) continue;
          if (from === to && reachable(kind, to)) continue; // the no-op case below
          refused++;
          let error: unknown;
          try {
            nextInvoiceStatus(kind, from, to);
          } catch (e) {
            error = e;
          }
          expect(error, key(kind, from, to)).toBeInstanceOf(InvalidTransitionError);
          expect((error as InvalidTransitionError).code).toBe("conflict");
          expect((error as InvalidTransitionError).message).toBe("finance.errors.invalid_transition");
          expect((error as InvalidTransitionError)).toMatchObject({ kind, from, to });
        }
      }
    }
    expect(refused).toBe(2 * 5 * 4 - TABLE.length - 5);
  });

  it("treats a repeated transition to the current status as a no-op", () => {
    expect(nextInvoiceStatus("invoice", "paid", "paid")).toBe("paid");
    expect(nextInvoiceStatus("invoice", "open", "open")).toBe("open");
    expect(nextInvoiceStatus("invoice", "cancelled", "cancelled")).toBe("cancelled");
    expect(nextInvoiceStatus("credit_note", "issued", "issued")).toBe("issued");
    expect(nextInvoiceStatus("credit_note", "paid", "paid")).toBe("paid");
    expect(() => nextInvoiceStatus("invoice", "issued", "issued")).toThrow(InvalidTransitionError);
    expect(() => nextInvoiceStatus("credit_note", "open", "open")).toThrow(InvalidTransitionError);
  });

  it("knows the terminal statuses", () => {
    expect(isTerminalStatus("invoice", "paid")).toBe(false); // paid -> cancelled by credit notes
    expect(isTerminalStatus("invoice", "cancelled")).toBe(true);
    expect(isTerminalStatus("invoice", "open")).toBe(false);
    expect(isTerminalStatus("credit_note", "paid")).toBe(true);
    expect(isTerminalStatus("credit_note", "issued")).toBe(false);
  });
});

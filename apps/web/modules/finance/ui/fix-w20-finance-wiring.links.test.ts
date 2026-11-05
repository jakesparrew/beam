/**
 * fix-w20-finance-wiring: the invoices list's "Export CSV of this filter" link opens the exports
 * form prefilled with kind `invoices` and the list's period (requests of finance-P5 and P7).
 */
import { describe, expect, it } from "vitest";
import { invoicesExportHref } from "./links";

const parse = (href: string) => {
  const url = new URL(href, "http://localhost");
  return { path: url.pathname, query: Object.fromEntries(url.searchParams) };
};

describe("invoicesExportHref", () => {
  it("carries the filter's period", () => {
    expect(parse(invoicesExportHref({ from: "2026-10-01", to: "2026-10-31" }))).toEqual({
      path: "/admin/finance/exports",
      query: { kind: "invoices", from: "2026-10-01", to: "2026-10-31" },
    });
  });

  it("leaves out a bound the list does not filter on, so the form keeps its default", () => {
    expect(parse(invoicesExportHref({}))).toEqual({ path: "/admin/finance/exports", query: { kind: "invoices" } });
    expect(parse(invoicesExportHref({ from: "2026-10-01" })).query).toEqual({ kind: "invoices", from: "2026-10-01" });
  });

  it("drops a malformed bound instead of passing it through", () => {
    expect(parse(invoicesExportHref({ from: "2026-10-01&kind=payments", to: "31/10/2026" })).query).toEqual({ kind: "invoices" });
  });
});

/**
 * Links between finance's back-office screens (fix-w20-finance-wiring): the invoices list's
 * "Export CSV of this filter" opens the exports form prefilled with kind `invoices` and the
 * list's period (request of finance-P5 and finance-P7). The exports form keeps its default
 * period (last month) for a bound the list does not filter on, and checks the 366-day limit.
 */
import type { Route } from "next";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `/admin/finance/exports?kind=invoices&from=<from>&to=<to>`; a missing or malformed bound is left out. */
export function invoicesExportHref(filter: { from?: string | undefined; to?: string | undefined }): Route {
  const query = new URLSearchParams({ kind: "invoices" });
  if (filter.from && DAY.test(filter.from)) query.set("from", filter.from);
  if (filter.to && DAY.test(filter.to)) query.set("to", filter.to);
  return `/admin/finance/exports?${query.toString()}` as Route;
}

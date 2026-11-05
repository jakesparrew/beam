/**
 * The report CSV registry (ops spec 4.3, ops-P3): the one map `/admin/reports/[report]/csv`
 * reads. Each report key has a row generator `(ctx, filters) => AsyncIterable<unknown[]>` in
 * `REPORT_CSV`, its header in `REPORT_CSV_COLUMNS` and its permission in `REPORT_CSV_PERMISSION`.
 * Later packages (ops-P7 no-shows, abandoned checkouts, capacity; ops-P8 marketing, attribution,
 * ads) write their generators in their own files and add one line per key here. A key is the URL
 * segment of its page (`/admin/reports/no-shows/csv`).

 * The R2 report files import only types from here (this file imports their generators).
 *
 * `OpsReadCtx` is the read context of ops' dashboard and report queries: a full `Ctx` (an
 * action's or a job's) fits, and a page builds one with `staffReadCtx()` from `./queries`.
 */
import type { DbOrTx } from "@beam/db";
import { ForbiddenError } from "@beam/core/errors";
import type { Locale } from "@beam/core/i18n";
import { actorHasPermission, type Actor, type Permission } from "@/lib/ctx";
import { abandonedCsvRows, ABANDONED_CSV_COLUMNS } from "./abandoned";
import { capacityCsvRows, CAPACITY_CSV_COLUMNS } from "./capacity";
import { liabilityCsvRows, LIABILITY_CSV_COLUMNS } from "./liability";
import { noShowCsvRows, NO_SHOW_CSV_COLUMNS } from "./no-shows";
import { revenueCsvRows, REVENUE_CSV_COLUMNS } from "./revenue";

/** What ops' read queries need: the database or transaction, the actor (permission checks), the clock and the locale. */
export type OpsReadCtx = { tx: DbOrTx; actor: Actor; now: Date; locale: Locale };

/** The URL filters of a report page, passed unchanged to its CSV (`?period=month&at=2026-11-04&vat=excl`). */
export type ReportFilters = Readonly<Record<string, string | undefined>>;

export const REPORT_KEYS = ["revenue", "liability", "no-shows", "abandoned-checkouts", "capacity"] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export type ReportCsv = (ctx: OpsReadCtx, filters: ReportFilters) => AsyncIterable<unknown[]>;

export const REPORT_CSV: Record<ReportKey, ReportCsv> = {
  revenue: revenueCsvRows,
  liability: liabilityCsvRows,
  "no-shows": noShowCsvRows,
  "abandoned-checkouts": abandonedCsvRows,
  capacity: capacityCsvRows,
};

export const REPORT_CSV_COLUMNS: Record<ReportKey, readonly string[]> = {
  revenue: REVENUE_CSV_COLUMNS,
  liability: LIABILITY_CSV_COLUMNS,
  "no-shows": NO_SHOW_CSV_COLUMNS,
  "abandoned-checkouts": ABANDONED_CSV_COLUMNS,
  capacity: CAPACITY_CSV_COLUMNS,
};

/** Every report CSV needs `reports.read` (ops spec 4.3). */
export const REPORT_CSV_PERMISSION: Record<ReportKey, Permission> = {
  revenue: "reports.read",
  liability: "reports.read",
  "no-shows": "reports.read",
  "abandoned-checkouts": "reports.read",
  capacity: "reports.read",
};

/** True when the actor holds at least one of `permissions` (staff only; `'*'` holds all). */
export function holdsAny(actor: Actor, ...permissions: Permission[]): boolean {
  return permissions.some((p) => actorHasPermission(actor, p));
}

/** Throws `ForbiddenError` unless the actor holds at least one of `permissions`. */
export function requireAny(ctx: Pick<OpsReadCtx, "actor">, ...permissions: Permission[]): void {
  if (!holdsAny(ctx.actor, ...permissions)) throw new ForbiddenError(`forbidden: ${permissions.join(" or ")}`);
}

export function isReportKey(value: string): value is ReportKey {
  return (REPORT_KEYS as readonly string[]).includes(value);
}


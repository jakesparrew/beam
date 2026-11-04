/**
 * ops queries, area `reports` (ops spec 4.2, ops-P3): the revenue report (rules 34, 35) and the
 * prepaid credits outstanding (rule 35a), both behind `reports.read`. They take an `OpsReadCtx`
 * (a page builds it with `staffReadCtx()`, an action or job passes its `Ctx`) and check the
 * permission on the actor, so a test or a job can call them without a session. Reading reports
 * is not audited (ops spec 7); the CSV route audits `data.exported`.
 */
import { RevenueReportInput, periodRange, type Period } from "@beam/core/ops";
import { requireStaff } from "@/lib/auth";
import { getAppDb, type Permission } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { computeCreditLiability, liabilityDateFor, type CreditLiability } from "./liability";
import { holdsAny, requireAny, type OpsReadCtx } from "./registry";
import { computeRevenueReport, type RevenueReport, type VatMode } from "./revenue";

export type { CreditLiability, OpsReadCtx, RevenueReport };

/**
 * The read context of an `(admin)` page: the signed-in staff actor after MFA (else the login
 * redirect; a missing `permission` renders 404), the app database, now and the admin locale.
 */
export async function staffReadCtx(opts: { permission?: Permission } = {}): Promise<OpsReadCtx> {
  const actor = await requireStaff(opts);
  return { tx: await getAppDb(), actor, now: new Date(), locale: await adminLocale() };
}

/** Rule 34 and 35 (`reports.read`): net revenue, comparisons, sales mix and the 90-day line. */
export async function getRevenueReport(ctx: OpsReadCtx, input: { period: Period; at: Date; vat?: VatMode }): Promise<RevenueReport> {
  requireAny(ctx, "reports.read");
  const parsed = RevenueReportInput.parse(input);
  return computeRevenueReport(ctx.tx, parsed);
}

/**
 * Rule 35a (`reports.read`): today's `v_credit_liability`, or credits' `getCreditLiabilityAsOf`
 * when `at` is a past date.
 */
export async function getCreditLiability(ctx: OpsReadCtx, input: { at?: Date } = {}): Promise<CreditLiability> {
  requireAny(ctx, "reports.read");
  return computeCreditLiability(ctx.tx, { at: input.at, now: ctx.now });
}

/** The liability shown on the revenue report: as of the end of the selected period when it is over, else today. */
export async function getCreditLiabilityForPeriod(ctx: OpsReadCtx, input: { period: Period; at: Date }): Promise<CreditLiability> {
  return getCreditLiability(ctx, { at: liabilityDateFor(periodRange(input.period, input.at).to, ctx.now) });
}

/** The report pages of `/admin/reports` the actor may open (V1: revenue; later packages add theirs). */
export const REPORT_PAGES = [{ key: "revenue", href: "/admin/reports/revenue", titleKey: "ops.reports.revenue.title", permission: "reports.read" }] as const satisfies readonly {
  key: string;
  href: string;
  titleKey: string;
  permission: Permission;
}[];

export function listReportPages(ctx: OpsReadCtx): (typeof REPORT_PAGES)[number][] {
  requireAny(ctx, "reports.read");
  return REPORT_PAGES.filter((p) => holdsAny(ctx.actor, p.permission));
}

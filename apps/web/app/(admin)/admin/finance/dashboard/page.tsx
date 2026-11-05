import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { getFinanceDashboard, type DashboardInput } from "@/modules/finance/queries";
import { FinanceDashboardView } from "@/modules/finance/ui/dashboard/finance-dashboard";
import { financeLabels } from "@/modules/finance/ui/labels";

const PERIODS = ["day", "week", "month", "ytd", "custom"] as const;
type Period = (typeof PERIODS)[number];
const isPeriod = (v: unknown): v is Period => typeof v === "string" && (PERIODS as readonly string[]).includes(v);

/**
 * `/admin/finance/dashboard` (`reports.finance`, finance spec section 5, blueprint 43): the R3
 * finance dashboard for `?period=day|week|month|ytd|custom` (default month) with `from` and `to`
 * for a custom range. A custom range that `resolvePeriod` refuses falls back to this month with a
 * message. Without `reports.finance` the page is a 404 (`requireStaff`).
 */
export default async function FinanceDashboardPage({ searchParams }: { searchParams: Promise<{ period?: string; from?: string; to?: string }> }) {
  await requireStaff({ permission: "reports.finance" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const db = await getAppDb();
  const labels = financeLabels(locale, ["dashboard"]);

  const period: Period = isPeriod(sp.period) ? sp.period : "month";
  const input: DashboardInput = period === "custom" ? { period, ...(sp.from ? { from: sp.from } : {}), ...(sp.to ? { to: sp.to } : {}) } : { period };
  let invalidCustom = false;
  let data;
  try {
    data = await getFinanceDashboard(db, input);
  } catch (error) {
    if (!(error instanceof RangeError) || period !== "custom") throw error;
    invalidCustom = true;
    data = await getFinanceDashboard(db, { period: "month" });
  }
  return <FinanceDashboardView data={data} labels={labels} locale={locale} invalidCustom={invalidCustom} />;
}

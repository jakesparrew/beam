import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { catalogueSection, getMonthlyReport } from "@/modules/platform/queries";
import { MonthlyReportView } from "@/modules/platform/ui/monthly-report-view";

/**
 * `/admin/system/reports/[id]` (`system.jobs`): one monthly SLA report; owner or technical_admin
 * edit the notes or a manual uptime and send it (a `sent` report is read-only, PL-89).
 */
export default async function MonthlyReportPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireStaff({ permission: "system.jobs" });
  const { id } = await params;
  const locale = await adminLocale();
  const tr = translator(locale);
  const report = await getMonthlyReport(await getAppDb(), id);
  if (!report) notFound();
  const monthName = new Date(`${report.monthOn}T12:00:00Z`).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "Europe/Brussels" });

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/system/reports" className="text-sm text-muted-foreground hover:underline">
          {tr("platform.reports.back")}
        </Link>
        <h1 className="text-2xl font-semibold">{tr("platform.reports.report_title", { month: monthName })}</h1>
      </header>
      <MonthlyReportView
        report={{
          id: report.id,
          monthOn: report.monthOn,
          status: report.status,
          notes: report.notes ?? "",
          sentAt: report.sentAt ? report.sentAt.toISOString() : null,
          sentBy: report.sentBy ?? null,
          data: report.data,
        }}
        canEdit={(actor.roleKey === "owner" || actor.roleKey === "technical_admin") && report.status === "draft"}
        locale={locale}
        labels={catalogueSection(locale, "platform.reports")}
        errors={catalogueSection(locale, "platform.errors")}
      />
    </div>
  );
}

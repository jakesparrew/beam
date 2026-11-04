import Link from "next/link";
import { listReportPages, staffReadCtx } from "@/modules/ops/reports/queries";
import { translator } from "@/lib/i18n";

/**
 * `/admin/reports` (ops spec 5, `reports.read`): the reports the user may open. V1 has the
 * revenue report; the R2 and R3 report packages add their pages to `REPORT_PAGES`.
 */
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  const tr = translator(ctx.locale);
  const pages = listReportPages(ctx);
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold">{tr("ops.reports.title")}</h1>
        <p className="text-sm text-muted-foreground">{tr("ops.reports.intro")}</p>
      </div>
      <ul className="grid max-w-xl gap-3" data-testid="report-list">
        {pages.map((p) => (
          <li key={p.key}>
            <Link
              href={p.href}
              className="block rounded-md border p-4 font-medium hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {tr(p.titleKey)}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

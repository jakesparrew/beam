import Link from "next/link";
import { Badge, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { listMonthlyReports } from "@/modules/platform/queries";

const TARGET = 99.5;

/** `/admin/system/reports` (`system.jobs`): the monthly SLA reports (uptime red below 99.5 %, PL-89). */
export default async function MonthlyReportsPage() {
  await requireStaff({ permission: "system.jobs" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`platform.reports.${k}`, p);
  const reports = await listMonthlyReports(await getAppDb());
  const monthName = (monthOn: string) => new Date(`${monthOn}T12:00:00Z`).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "Europe/Brussels" });
  const pct = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground">{t("intro")}</p>
      </header>
      {reports.length === 0 ? (
        <EmptyState title={t("empty")} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("month")}</TableHead>
              <TableHead>{t("uptime")}</TableHead>
              <TableHead>{t("downtime")}</TableHead>
              <TableHead>{t("incidents")}</TableHead>
              <TableHead>{t("dead_jobs")}</TableHead>
              <TableHead>{t("col_status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reports.map((r) => {
              const below = r.data.uptime_pct !== null && r.data.uptime_pct < TARGET;
              return (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link href={`/admin/system/reports/${r.id}`} className="font-medium hover:underline">
                      {monthName(r.monthOn)}
                    </Link>
                  </TableCell>
                  <TableCell className={below ? "font-semibold text-destructive" : undefined}>{r.data.uptime_pct === null ? "–" : `${pct.format(r.data.uptime_pct)} %`}</TableCell>
                  <TableCell>{r.data.downtime_minutes === null ? "–" : t("minutes", { n: r.data.downtime_minutes })}</TableCell>
                  <TableCell>
                    {r.data.incidents.critical} / {r.data.incidents.high} / {r.data.incidents.normal}
                  </TableCell>
                  <TableCell>{r.data.dead_jobs}</TableCell>
                  <TableCell>
                    <Badge variant={r.status === "sent" ? "secondary" : "warning"}>{t(`status_${r.status}`)}</Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/**
 * `/admin/forms/[formId]/report` (`reports.read` or `forms.write`; forms spec section 5): the funnel
 * (views, started, engaged, completed, abandoned), completion rate, outcome distribution and
 * conversions to booking and purchase within 30 days with revenue, grouped by day, version,
 * source, campaign, funnel or link over a date range (default: the last 30 Brussels days), with a
 * CSV of the table. "Not enough data yet" below one start.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { brusselsDay } from "@beam/core/forms";
import { formatMoney, formatNumber, formatPercent } from "@beam/core/i18n";
import { Button, Card, CardContent, CardHeader, CardTitle, EmptyState, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getForm, getFormReport, REPORT_GROUPS, screenLabels, type ReportGroupBy } from "@/modules/forms/queries";
import { FunnelChart } from "@/modules/forms/ui/admin/funnel-chart";
import { ReportTable } from "@/modules/forms/ui/admin/report-table";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f-]{36}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const selectClass = "h-9 rounded-md border bg-background px-2 text-sm";

export default async function FormReportPage({ params, searchParams }: { params: Promise<{ formId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "reports.read") && !hasPermission(actor, "forms.write")) notFound();
  const { formId } = await params;
  if (!UUID.test(formId)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const db = await getAppDb();
  const form = await getForm(db, formId);
  if (!form) notFound();

  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? sp[k] : undefined);
  const today = brusselsDay(new Date());
  const to = str("to") && DAY_RE.test(str("to")!) ? str("to")! : today;
  const from = str("from") && DAY_RE.test(str("from")!) ? str("from")! : brusselsDay(new Date(Date.parse(`${to}T12:00:00Z`) - 29 * 86_400_000));
  const groupBy: ReportGroupBy = (REPORT_GROUPS as readonly string[]).includes(str("groupBy") ?? "") ? (str("groupBy") as ReportGroupBy) : "day";
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const report = await getFormReport(db, { formId, from: lo, to: hi, groupBy });
  const labels = screenLabels(locale, ["report"]);
  const pct = (v: number | null) => (v === null ? "—" : formatPercent(v * 100, locale));
  const t = report.totals;

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("forms.report.title", { name: form.name[locale] || form.slug })}</h1>
        <div className="flex flex-wrap gap-4 text-sm">
          {hasPermission(actor, "forms.write") && hasPermission(actor, "persons.read") ? (
            <Link className="underline" href={`/admin/forms/${form.id}/submissions` as never}>
              {tr("forms.report.submissions_link")}
            </Link>
          ) : null}
          {hasPermission(actor, "forms.write") ? (
            <Link className="underline" href={`/admin/forms/${form.id}`}>
              {tr("forms.report.back_to_overview")}
            </Link>
          ) : null}
        </div>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border p-3">
        <label className="grid gap-1 text-sm">
          {tr("forms.report.from")}
          <Input type="date" name="from" defaultValue={lo} className="w-40" />
        </label>
        <label className="grid gap-1 text-sm">
          {tr("forms.report.to")}
          <Input type="date" name="to" defaultValue={hi} className="w-40" />
        </label>
        <label className="grid gap-1 text-sm">
          {tr("forms.report.group_by")}
          <select name="groupBy" defaultValue={groupBy} className={selectClass}>
            {REPORT_GROUPS.map((g) => (
              <option key={g} value={g}>
                {tr(`forms.report.group_${g}`)}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit">{tr("forms.report.apply")}</Button>
      </form>

      {t.started < 1 ? (
        <EmptyState title={tr("forms.report.empty")} />
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{tr("forms.report.funnel_title")}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3">
                <FunnelChart steps={t} locale={locale} labels={labels} />
                <p className="text-sm">
                  {tr("forms.report.completion_rate")}: <strong>{pct(t.completionRate)}</strong>
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{tr("forms.report.conversions_title")}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-2 text-sm">
                  <dt className="text-muted-foreground">{tr("forms.report.linked")}</dt>
                  <dd className="text-right tabular-nums">{formatNumber(t.linked, locale)}</dd>
                  <dt className="text-muted-foreground">{tr("forms.report.booked")}</dt>
                  <dd className="text-right tabular-nums">
                    {formatNumber(t.booked, locale)} ({pct(t.bookingRate)})
                  </dd>
                  <dt className="text-muted-foreground">{tr("forms.report.purchased")}</dt>
                  <dd className="text-right tabular-nums">
                    {formatNumber(t.purchased, locale)} ({pct(t.purchaseRate)})
                  </dd>
                  <dt className="text-muted-foreground">{tr("forms.report.revenue")}</dt>
                  <dd className="text-right tabular-nums">{formatMoney(t.revenueCents, locale)}</dd>
                </dl>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{tr("forms.report.outcomes_title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{tr("forms.report.outcome")}</TableHead>
                    <TableHead className="text-right">{tr("forms.report.count")}</TableHead>
                    <TableHead className="text-right">{tr("forms.report.share")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {report.outcomes.map((o) => (
                    <TableRow key={o.key ?? "none"}>
                      <TableCell>{o.key ? (o.label?.[locale] ?? o.key) : tr("forms.report.no_outcome")}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(o.count, locale)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(o.share)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <ReportTable report={report} locale={locale} labels={labels} fileName={`${form.slug}-report-${groupBy}-${lo}-${hi}.csv`} />
        </>
      )}
    </div>
  );
}

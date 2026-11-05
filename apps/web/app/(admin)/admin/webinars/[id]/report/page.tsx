import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { formatMoney, formatNumber, formatPercent } from "@beam/core/i18n";
import { WATCH_MODES } from "@beam/core/webinar";
import { webinars } from "@beam/db/schema";
import { Button, EmptyState, buttonVariants } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { eq, getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { exportWebinarRegistrants } from "@/modules/webinar/actions";
import { REPORT_PERIODS, buildReportCsv, canReadWebinarReport, getWebinarReportFor, isReportPeriod } from "@/modules/webinar/queries";
import { textIn } from "@/modules/webinar/server/lifecycle";
import { CtaTable } from "@/modules/webinar/ui/report/cta-table";
import { PollResults } from "@/modules/webinar/ui/report/poll-results";
import { SegmentTable } from "@/modules/webinar/ui/report/segment-table";
import { SummaryCards } from "@/modules/webinar/ui/report/summary-cards";
import { UtmTable } from "@/modules/webinar/ui/report/utm-table";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_ID = /^[0-9a-f-]{36}$/i;

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ period?: string; file?: string; error?: string }> };

/**
 * `/admin/webinars/[id]/report` (`webinars.host` or `reports.read`, webinar spec 5.1, rules
 * 39-41): the period selector (7, 14, 30, 60, 90 or 180 days; default the webinar's conversion
 * window), summary cards, the table by lead/customer/member/total and by mode, poll results per
 * option per mode, the CTA table and the UTM table. "Download report CSV" is the aggregate CSV
 * (no personal data, a `data:` link); "Download registrants CSV" (`persons.export` and
 * `webinars.host`) runs `exportWebinarRegistrants` and comes back with the file's link.
 */
export default async function WebinarReportPage({ params, searchParams }: Props) {
  const actor = await requireStaff();
  if (!canReadWebinarReport(actor)) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const g = (k: string, p?: Record<string, string | number>) => tr(`webinar.admin.report.${k}`, p);
  const db = await getAppDb();
  const [w] = await db.select().from(webinars).where(eq(webinars.id, id.toLowerCase()));
  if (!w) notFound();
  const sp = await searchParams;
  const asked = Number(sp.period);
  const periodDays = isReportPeriod(asked) ? asked : w.conversionWindowDays;
  const report = await getWebinarReportFor(actor, db, w.id, { periodDays });
  const canHost = hasPermission(actor, "webinars.host");
  const canExport = canHost && hasPermission(actor, "persons.export");
  const here = `/admin/webinars/${w.id}/report`;
  const title = textIn(w.title, locale) || w.slug;

  async function exportRegistrants() {
    "use server";
    const res = await exportWebinarRegistrants({ webinarId: w!.id });
    const back = `${here}?period=${periodDays}`;
    redirect((res.ok ? `${back}&file=${res.data.fileId}` : `${back}&error=${encodeURIComponent(res.error.code)}`) as Route);
  }

  const modes = Object.fromEntries(WATCH_MODES.map((m) => [m, tr(`webinar.enum.watch_mode.${m}`)])) as Record<(typeof WATCH_MODES)[number], string>;
  const text = (t: Record<string, string | undefined> | null | undefined) => textIn(t as Parameters<typeof textIn>[0], locale);
  const csv = buildReportCsv(report, locale);
  const csvHref = `data:text/csv;charset=utf-8,${encodeURIComponent(`﻿${csv}`)}`;
  const fileId = sp.file && FILE_ID.test(sp.file) ? sp.file : null;
  const t = report.totals;

  return (
    <div className="grid gap-6">
      <nav aria-label={g("links")} className="flex flex-wrap gap-4 text-sm">
        {canHost ? (
          <>
            <Link href={`/admin/webinars/${w.id}` as Route} className="underline">
              {g("back")}
            </Link>
            <Link href={`/admin/webinars/${w.id}/host` as Route} className="underline">
              {g("host_link")}
            </Link>
          </>
        ) : null}
      </nav>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold">{g("title", { title })}</h1>
        <p className="text-sm text-muted-foreground">{g("period_note", { days: report.periodDays })}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm">
            <span>{g("period")}</span>
            <select name="period" defaultValue={String(periodDays)} className="h-9 rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {isReportPeriod(w.conversionWindowDays) ? null : <option value={String(w.conversionWindowDays)}>{g("period_default", { days: w.conversionWindowDays })}</option>}
              {REPORT_PERIODS.map((d) => (
                <option key={d} value={String(d)}>
                  {d === w.conversionWindowDays ? g("period_default", { days: d }) : g("period_option", { days: d })}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" size="sm">
            {g("apply")}
          </Button>
        </form>
        <a href={csvHref} download={`webinar-${w.slug}-report-${report.periodDays}d.csv`} className={buttonVariants({ variant: "outline", size: "sm" })}>
          {g("download_report")}
        </a>
        {canExport ? (
          <form action={exportRegistrants}>
            <Button type="submit" variant="outline" size="sm">
              {g("download_registrants")}
            </Button>
          </form>
        ) : null}
      </div>
      <div aria-live="polite">
        {fileId ? (
          <p role="status" className="rounded-md border border-border p-3 text-sm">
            {g("export_ready")}{" "}
            <a href={`/api/public/files/${fileId}`} className="underline" download>
              {g("export_download")}
            </a>
          </p>
        ) : null}
        {sp.error ? <p className="rounded-md border border-destructive p-3 text-sm">{g("export_failed", { error: sp.error.slice(0, 40) })}</p> : null}
      </div>
      <p className="text-sm text-muted-foreground">{g("period_hint")}</p>
      {report.detailRemoved ? <p className="rounded-md border border-border p-3 text-sm">{g("detail_removed")}</p> : null}

      {t.registrations === 0 ? (
        <EmptyState title={g("empty")} />
      ) : (
        <>
          <SummaryCards
            label={g("summary.label")}
            cards={[
              { key: "registrations", label: g("summary.registrations"), value: formatNumber(t.registrations, locale) },
              { key: "live_attended", label: g("summary.live_attended"), value: formatNumber(t.modes.live.attended, locale) },
              { key: "replay_viewers", label: g("summary.replay_viewers"), value: formatNumber(t.modes.replay.viewers, locale) },
              { key: "on_demand_viewers", label: g("summary.on_demand_viewers"), value: formatNumber(t.modes.on_demand.viewers, locale) },
              { key: "converted", label: g("summary.converted"), value: formatNumber(t.converted, locale), hint: g("summary.conversion_rate", { rate: formatPercent(t.conversionRate, locale) }) },
              { key: "revenue", label: g("summary.revenue"), value: formatMoney(t.revenueCents, locale) },
            ]}
          />
          <section aria-labelledby="report-segments" className="grid gap-3">
            <h2 id="report-segments" className="text-lg font-semibold">
              {g("segments.title")}
            </h2>
            <SegmentTable
              bySegment={report.bySegment}
              totals={t}
              locale={locale}
              labels={{
                metric: g("segments.metric"),
                segments: { lead: g("segments.lead"), customer: g("segments.customer"), member: g("segments.member"), total: g("segments.total") },
                modes,
                modeCaption: g("segments.mode_caption", { mode: "{mode}" }),
                conversionCaption: g("segments.conversion_caption", { days: report.periodDays }),
                metrics: {
                  registered: g("metrics.registered"),
                  started: g("metrics.started"),
                  attended: g("metrics.attended"),
                  watched15m: g("metrics.watched_15m"),
                  watched30m: g("metrics.watched_30m"),
                  watchedHalf: g("metrics.watched_half"),
                  watchedEnd: g("metrics.watched_end"),
                  avgWatchMinutes: g("metrics.avg_watch_minutes"),
                  pollResponses: g("metrics.poll_responses"),
                  ctaShown: g("metrics.cta_shown"),
                  ctaClicked: g("metrics.cta_clicked"),
                },
                conversion: {
                  registrations: g("conversion.registrations"),
                  booked: g("conversion.booked"),
                  purchased: g("conversion.purchased"),
                  converted: g("conversion.converted"),
                  conversionRate: g("conversion.conversion_rate"),
                  revenue: g("conversion.revenue"),
                },
              }}
            />
          </section>
          <PollResults
            locale={locale}
            polls={report.polls.map((p) => ({
              pollId: p.pollId,
              key: p.key,
              question: text(p.question),
              isActive: p.isActive,
              respondents: p.respondents,
              options: p.options.map((o) => ({ key: o.key, label: text(o.label) || o.key, counts: o.counts })),
            }))}
            labels={{ title: g("polls.title"), empty: g("polls.empty"), option: g("polls.option"), respondents: g("polls.respondents"), inactive: g("inactive"), modes }}
          />
          <CtaTable
            locale={locale}
            ctas={report.ctas.map((c) => ({ ...c, label: text(c.label) || c.key }))}
            labels={{
              title: g("ctas.title"),
              empty: g("ctas.empty"),
              cta: g("ctas.cta"),
              shown: g("ctas.shown", { mode: "{mode}" }),
              clicked: g("ctas.clicked", { mode: "{mode}" }),
              ctr: g("ctas.ctr"),
              bookedAfter: g("ctas.booked_after", { days: report.periodDays }),
              purchasedAfter: g("ctas.purchased_after", { days: report.periodDays }),
              inactive: g("inactive"),
              modes,
            }}
          />
          <UtmTable
            locale={locale}
            rows={report.utm}
            labels={{
              title: g("utm.title"),
              empty: g("utm.empty"),
              source: g("utm.source"),
              campaign: g("utm.campaign"),
              none: g("utm.none"),
              registrations: g("utm.registrations"),
              attended: g("utm.attended"),
              converted: g("utm.converted"),
            }}
          />
        </>
      )}
    </div>
  );
}

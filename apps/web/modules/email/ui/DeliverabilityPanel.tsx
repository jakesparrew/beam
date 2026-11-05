/**
 * The email overview of `/admin/email` (email spec section 5, rules 6, 38 and 38a): the
 * complaint banner and the "Email delivery problem" banner, KPI tiles of the last 30 days, domain
 * status for `mail.beam.be` and `news.beam.be` (from the last `email.check_domains` run), the
 * warm-up week, today's cap and sent count, the 7-day rates, blocked-translation messages and the
 * last 20 suppressions (masked). Server component: labels come in through `t`.
 */
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle, Badge, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import type { Deliverability } from "../queries";
import { formatCount, formatRate, KpiTiles, type KpiTile } from "./KpiTiles";

type T = (key: string, params?: Record<string, string | number>) => string;

export function DeliverabilityPanel({ data, locale, t }: { data: Deliverability; locale: string; t: T }) {
  const n = (v: number) => formatCount(locale, v);
  const pct = (v: number | null) => formatRate(locale, v);
  const time = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" });
  const k = data.kpis;
  const tiles: KpiTile[] = [
    { key: "sent", label: t("kpi_sent"), value: n(k.sent) },
    { key: "delivered", label: t("kpi_delivered"), value: pct(k.deliveredRate) },
    { key: "open_rate", label: t("kpi_open_rate"), value: pct(k.openRate) },
    { key: "click_rate", label: t("kpi_click_rate"), value: pct(k.clickRate) },
    { key: "hard_bounce", label: t("kpi_hard_bounce"), value: pct(k.hardBounceRate), tone: (k.hardBounceRate ?? 0) > 0.02 ? "warning" : "default" },
    { key: "complaint", label: t("kpi_complaint"), value: pct(k.complaintRate), tone: (k.complaintRate ?? 0) > 0.001 ? "danger" : "default" },
    { key: "unsubscribes", label: t("kpi_unsubscribes"), value: n(k.unsubscribes) },
  ];

  return (
    <div className="grid gap-8" data-testid="email-overview">
      {data.complaint.alert ? (
        <Alert variant="destructive" data-testid="complaint-banner">
          <AlertTitle>{t("complaint_banner_title")}</AlertTitle>
          <AlertDescription>
            {t("complaint_banner", { rate: pct(data.complaint.rate), complained: n(data.complaint.complained), delivered: n(data.complaint.delivered), threshold: `${data.complaint.thresholdPct} %` })}
          </AlertDescription>
        </Alert>
      ) : null}
      {data.delivery.checks.length ? (
        <Alert variant="destructive" data-testid="delivery-banner">
          <AlertTitle>{t("delivery_banner_title")}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-5">
              {data.delivery.checks.map((c) => (
                <li key={c}>
                  {t(`delivery_check_${c}`, {
                    minutes: data.delivery.health.oldestQueuedMinutes ?? 0,
                    count: data.delivery.health.deadSends15m,
                  })}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">{t("kpi_title")}</h2>
        <KpiTiles tiles={tiles} testId="email-kpis" />
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="grid content-start gap-2" data-testid="email-domains">
          <h2 className="text-lg font-semibold">{t("domains_title")}</h2>
          <ul className="grid gap-2 text-sm">
            {data.domains.map((d) => (
              <li key={d.domain} className="flex items-center justify-between gap-3 rounded-md border p-3" data-domain={d.domain}>
                <span className="font-medium">{d.domain}</span>
                <Badge variant={d.status === "verified" ? "default" : d.status === "problem" ? "destructive" : "secondary"}>{t(`domain_${d.status}`)}</Badge>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            {data.domains[0]?.checkedAt ? t("last_check", { at: time.format(data.domains[0].checkedAt) }) : t("never_checked")} {t("domains_hint")}
          </p>
        </section>

        <section className="grid content-start gap-2" data-testid="email-warmup">
          <h2 className="text-lg font-semibold">{t("warmup_title")}</h2>
          {data.warmup.warmingUp ? (
            <dl className="grid gap-1 text-sm">
              <div className="flex justify-between gap-3">
                <dt>{t("warmup_week_label")}</dt>
                <dd className="tabular-nums">{t("warmup_week", { week: data.warmup.week ?? 1 })}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>{t("warmup_cap")}</dt>
                <dd className="tabular-nums">{n(data.warmup.cap ?? 0)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>{t("warmup_sent_today")}</dt>
                <dd className="tabular-nums">{n(data.warmup.sentToday)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{t("warmup_done", { count: n(data.warmup.sentToday) })}</p>
          )}
        </section>

        <section className="grid content-start gap-2">
          <h2 className="text-lg font-semibold">{t("rates7d_title")}</h2>
          <dl className="grid gap-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt>{t("bounce_7d")}</dt>
              <dd className="tabular-nums">{pct(data.rates7d.bounceRate)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>{t("complaint_7d")}</dt>
              <dd className="tabular-nums">{pct(data.rates7d.complaintRate)}</dd>
            </div>
          </dl>
        </section>
      </div>

      <section className="grid gap-2" data-testid="email-blocked">
        <h2 className="text-lg font-semibold">{t("blocked_title")}</h2>
        {data.blocked.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_time")}</TableHead>
                <TableHead>{t("col_template")}</TableHead>
                <TableHead>{t("col_locale")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.blocked.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>{time.format(b.updatedAt)}</TableCell>
                  <TableCell>{b.templateSlug ?? "–"}</TableCell>
                  <TableCell>{b.locale}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="link" size="sm" asChild>
                      <Link href={`/admin/email/messages/${b.id}`}>{t("open_message")}</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">{t("blocked_empty")}</p>
        )}
      </section>

      <section className="grid gap-2" data-testid="email-suppressions">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{t("suppressions_title")}</h2>
          <Button variant="outline" size="sm" asChild>
            <Link href="/admin/persons">{t("add_suppression")}</Link>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("add_suppression_hint")}</p>
        {data.suppressions.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("col_time")}</TableHead>
                <TableHead>{t("col_email")}</TableHead>
                <TableHead>{t("col_reason")}</TableHead>
                <TableHead>{t("col_scope")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.suppressions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>{time.format(s.createdAt)}</TableCell>
                  <TableCell>{s.email ?? "–"}</TableCell>
                  <TableCell>{t(`suppression_reason_${s.reason}`)}</TableCell>
                  <TableCell>{t(`suppression_scope_${s.scope}`)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">{t("suppressions_empty")}</p>
        )}
      </section>
    </div>
  );
}

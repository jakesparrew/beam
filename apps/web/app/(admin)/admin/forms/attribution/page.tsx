/**
 * `/admin/forms/attribution` (R3, forms-P9; `reports.read` or `forms.write`): the marketing view of
 * forms over a Brussels date range (default: the last 30 days). KPI cards from `v_form_kpis_daily`
 * (leads created by forms, completions, result CTA clicks, conversions within 30 days and their
 * revenue), campaign attribution per `utm_campaign` from `v_form_campaign_attribution` (leads,
 * completions, bookings, 30-day revenue, ad spend and cost per lead) and the partner and referral
 * tracked links with their counts. No answer value and no sensitive data is shown; a referrer is
 * a link to the person page for staff with `persons.read` only.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { brusselsDay } from "@beam/core/forms";
import { formatMoney, formatNumber, formatPercent } from "@beam/core/i18n";
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getCampaignAttribution, getFormKpis, listAttributedLinkCounts } from "@/modules/forms/queries";
import { AttributionTable } from "@/modules/forms/ui/admin/attribution-table";

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function FormAttributionPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "reports.read") && !hasPermission(actor, "forms.write")) notFound();
  const locale = await adminLocale();
  const tr = translator(locale);
  const t = (k: string, p?: Record<string, string | number>) => tr(`forms.attribution.${k}`, p);
  const db = await getAppDb();

  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" && DAY_RE.test(sp[k]) ? sp[k] : undefined);
  const to = str("to") ?? brusselsDay(new Date());
  const from = str("from") ?? brusselsDay(new Date(Date.parse(`${to}T12:00:00Z`) - 29 * 86_400_000));
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  const range = { from: lo, to: hi };

  const [kpis, campaigns, links] = await Promise.all([getFormKpis(db, range), getCampaignAttribution(db, range), listAttributedLinkCounts(db, { companyId: null, range })]);
  const k = kpis.totals;
  const num = (n: number) => formatNumber(n, locale);
  const showPeople = hasPermission(actor, "persons.read");
  const cards: { key: string; value: string; hint?: string }[] = [
    { key: "kpi_leads", value: num(k.leads) },
    { key: "kpi_completions", value: num(k.completions) },
    { key: "kpi_cta_clicks", value: num(k.ctaClicks) },
    { key: "kpi_conversions", value: num(k.conversions), hint: k.conversionRate === null ? undefined : t("kpi_conversion_rate", { rate: formatPercent(k.conversionRate * 100, locale) }) },
    { key: "kpi_revenue", value: formatMoney(k.revenue30dCents, locale) },
  ];

  return (
    <div className="grid gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="max-w-prose text-sm text-muted-foreground">{t("intro")}</p>
        </div>
        {hasPermission(actor, "forms.write") ? (
          <Link className="text-sm underline" href="/admin/forms">
            {t("back_to_forms")}
          </Link>
        ) : null}
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border p-3">
        <label className="grid gap-1 text-sm">
          {t("from")}
          <Input type="date" name="from" defaultValue={lo} className="w-40" />
        </label>
        <label className="grid gap-1 text-sm">
          {t("to")}
          <Input type="date" name="to" defaultValue={hi} className="w-40" />
        </label>
        <Button type="submit">{t("apply")}</Button>
      </form>

      <section aria-labelledby="attribution-kpis" className="grid gap-3">
        <h2 id="attribution-kpis" className="sr-only">
          {t("kpis_title")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {cards.map((c) => (
            <Card key={c.key}>
              <CardHeader>
                <CardTitle className="text-sm font-medium text-muted-foreground">{t(c.key)}</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-1">
                <p className="text-2xl font-semibold tabular-nums">{c.value}</p>
                {c.hint ? <p className="text-xs text-muted-foreground">{c.hint}</p> : null}
              </CardContent>
            </Card>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("kpis_note")}</p>
      </section>

      <AttributionTable
        data={campaigns}
        locale={locale}
        fileName={`forms-campaign-attribution-${lo}-${hi}.csv`}
        labels={{
          title: t("campaigns_title"),
          campaign: t("col_campaign"),
          leads: t("col_leads"),
          completions: t("col_completions"),
          bookings: t("col_bookings"),
          revenue: t("col_revenue"),
          spend: t("col_spend"),
          costPerLead: t("col_cost_per_lead"),
          noCampaign: t("no_campaign"),
          total: t("total"),
          downloadCsv: t("download_csv"),
          empty: t("campaigns_empty"),
        }}
      />

      <section aria-labelledby="attribution-links" className="grid gap-3">
        <h2 id="attribution-links" className="text-lg font-semibold">
          {t("links_title")}
        </h2>
        {links.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("links_empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("col_link")}</TableHead>
                <TableHead scope="col">{t("col_form")}</TableHead>
                <TableHead scope="col">{t("col_partner")}</TableHead>
                <TableHead scope="col">{t("col_referrer")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("col_views")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("col_starts")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("col_completions")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {links.map((l) => (
                <TableRow key={l.linkId}>
                  <TableCell>
                    {l.name}
                    {l.isActive ? null : <span className="ml-2 text-xs text-muted-foreground">({t("inactive")})</span>}
                  </TableCell>
                  <TableCell>{l.formName[locale]?.trim() || l.formSlug}</TableCell>
                  <TableCell>{l.partnerName ?? "—"}</TableCell>
                  <TableCell>
                    {l.referrerPersonId ? (
                      showPeople ? (
                        <Link className="underline" href={`/admin/persons/${l.referrerPersonId}` as never}>
                          {t("open_referrer")}
                        </Link>
                      ) : (
                        t("has_referrer")
                      )
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{num(l.views)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(l.starts)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(l.completions)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

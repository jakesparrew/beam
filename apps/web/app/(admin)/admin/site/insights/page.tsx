import NextLink from "next/link";
import { Button, EmptyState } from "@beam/ui";
import { formatMoney } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { adminLocale } from "@/lib/i18n";
import { notFound } from "next/navigation";
import { siteAdminLabels } from "@/modules/site/queries/admin";
import { SiteSectionNav } from "@/modules/site/ui/admin/pages-table";
import { getLandingInsightsFor, insightsCsv } from "@/modules/site/queries/insights";

const inputClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs";

/**
 * `/admin/site/insights` (site spec section 5, R3; site-P9): per landing page and UTM campaign,
 * form submissions, new persons, orders and revenue in a period of Brussels days (default the
 * last 30 days), with totals and a CSV export. Needs `reports.read` and `site.edit`.
 */
export default async function SiteInsightsPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  const actor = await requireStaff({ permission: "reports.read" });
  if (!hasPermission(actor, "site.edit")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const L = siteAdminLabels(locale);
  const data = await getLandingInsightsFor(actor, { from: sp.from ?? null, to: sp.to ?? null });
  const money = (cents: number) => formatMoney(cents, locale);
  const csv = insightsCsv(data, {
    landingPath: L["insights.col.landingPath"] ?? "landingPath",
    page: L["insights.col.page"] ?? "page",
    campaign: L["insights.col.campaign"] ?? "campaign",
    submissions: L["insights.col.submissions"] ?? "submissions",
    newPersons: L["insights.col.newPersons"] ?? "newPersons",
    orders: L["insights.col.orders"] ?? "orders",
    revenue: L["insights.col.revenue"] ?? "revenue",
  });
  const csvHref = `data:text/csv;charset=utf-8,${encodeURIComponent(`\uFEFF${csv}`)}`;
  const num = (n: number) => n.toLocaleString(locale);
  return (
    <div className="grid gap-6">
      <div className="grid gap-1">
        <NextLink href="/admin/site" className="text-sm underline hover:no-underline">
          {L["nav.website"]}
        </NextLink>
        <h1 className="text-2xl font-semibold">{L["insights.title"]}</h1>
        <p className="text-sm text-muted-foreground">{L["insights.intro"]}</p>
      </div>
      <SiteSectionNav L={L} current="/admin/site/insights" />
      <form className="flex flex-wrap items-end gap-3" action="/admin/site/insights">
        <label className="grid gap-1 text-sm">
          {L["insights.from"]}
          <input type="date" name="from" defaultValue={data.fromDay} className={inputClass} />
        </label>
        <label className="grid gap-1 text-sm">
          {L["insights.to"]}
          <input type="date" name="to" defaultValue={data.toDay} className={inputClass} />
        </label>
        <Button type="submit" variant="outline">
          {L["insights.apply"]}
        </Button>
        {data.rows.length ? (
          <a href={csvHref} download={`landing-insights-${data.fromDay}-${data.toDay}.csv`} className="text-sm underline hover:no-underline">
            {L["insights.export"]}
          </a>
        ) : null}
      </form>
      {data.rows.length === 0 ? (
        <EmptyState title={L["insights.empty"]} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{L["insights.title"]}</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-2 pr-4">{L["insights.col.page"]}</th>
                <th scope="col" className="py-2 pr-4">{L["insights.col.campaign"]}</th>
                <th scope="col" className="py-2 pr-4 text-right">{L["insights.col.submissions"]}</th>
                <th scope="col" className="py-2 pr-4 text-right">{L["insights.col.newPersons"]}</th>
                <th scope="col" className="py-2 pr-4 text-right">{L["insights.col.orders"]}</th>
                <th scope="col" className="py-2 text-right">{L["insights.col.revenue"]}</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={`${r.landingPath ?? ""}|${r.utmCampaign ?? ""}`} className="border-b align-top">
                  <td className="py-2 pr-4">
                    {r.page ? (
                      <NextLink href={`/admin/site/pages/${r.page.pageId}`} className="font-medium underline hover:no-underline">
                        {r.page.title}
                      </NextLink>
                    ) : (
                      <span className="text-muted-foreground">{r.landingPath ? L["insights.unknownPage"] : L["insights.noPath"]}</span>
                    )}
                    {r.landingPath ? <span className="block font-mono text-xs text-muted-foreground">{r.landingPath}</span> : null}
                  </td>
                  <td className="py-2 pr-4">{r.utmCampaign ?? <span className="text-muted-foreground">{L["insights.noCampaign"]}</span>}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{num(r.submissions)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{num(r.newPersons)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{num(r.orders)}</td>
                  <td className="py-2 text-right tabular-nums">{money(r.revenueCents)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-semibold">
                <th scope="row" colSpan={2} className="py-2 pr-4 text-left">{L["insights.total"]}</th>
                <td className="py-2 pr-4 text-right tabular-nums">{num(data.totals.submissions)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{num(data.totals.newPersons)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{num(data.totals.orders)}</td>
                <td className="py-2 text-right tabular-nums">{money(data.totals.revenueCents)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

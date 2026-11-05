import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { Alert, Badge, Button, EmptyState, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@beam/ui";
import { formatDate, formatDateTime, formatMoney, formatNumber } from "@beam/core/i18n";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { getSettingWithVersion } from "@/lib/settings";
import { pullAdsNow } from "@/modules/ops/marketing/actions";
import { ADS_STALE_DAYS, brusselsDay } from "@/modules/ops/marketing/ads";
import { getAdsReport } from "@/modules/ops/marketing/queries";
import { updateSetting } from "@/modules/platform/actions";
import { staffReadCtx } from "@/modules/ops/reports/queries";
import { holdsAny } from "@/modules/ops/reports/registry";

/**
 * `/admin/reports/ads` (ops spec 5, rule 74; `reports.read`, behind `ff_ops_marketing`): spend,
 * impressions, clicks and platform-reported leads per campaign and per campaign and day of the
 * `?from=&to=` dates, the last pull per account and the data-as-of date. Users with
 * `settings.write` also get the account form, which submits platform's
 * `updateSetting({ key: 'ads', value, expectedVersion })` (ops has no settings action, decision
 * 17), and "Pull now" (`pullAdsNow`, the last N days of every account).
 */
export const dynamic = "force-dynamic";

const BASE = "/admin/reports/ads";

const ids = (value: FormDataEntryValue | null): string[] =>
  [...new Set(String(value ?? "").split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];

const back = (params: Record<string, string>): Route => `${BASE}?${new URLSearchParams(params).toString()}` as Route;

export default async function AdsReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; saved?: string; queued?: string; error?: string }> }) {
  const ctx = await staffReadCtx({ permission: "reports.read" });
  if (!(await flag("ff_ops_marketing", ctx.actor))) notFound();
  const sp = await searchParams;
  const tr = translator(ctx.locale);
  const r = await getAdsReport(ctx, { from: sp.from, to: sp.to });
  const canEdit = holdsAny(ctx.actor, "settings.write");
  const { version } = canEdit ? await getSettingWithVersion(ctx.tx, "ads") : { version: 0 };
  const money = (c: number) => formatMoney(c, ctx.locale);
  const count = (n: number) => formatNumber(n, ctx.locale);
  const query = new URLSearchParams(r.range).toString();
  const noAccounts = r.accounts.length === 0;
  const today = brusselsDay(ctx.now);
  const stale = (lastPulledAt: Date | null) =>
    !lastPulledAt || Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${brusselsDay(lastPulledAt)}T00:00:00Z`)) / 86_400_000) >= ADS_STALE_DAYS;

  async function saveAccounts(form: FormData) {
    "use server";
    const value = { meta_account_ids: ids(form.get("meta_account_ids")), google_customer_ids: ids(form.get("google_customer_ids")) };
    if ([...value.meta_account_ids, ...value.google_customer_ids].some((v) => v.length > 64)) redirect(back({ error: "invalid" }));
    const res = await updateSetting({ key: "ads", value, expectedVersion: Number(form.get("version") ?? 0) });
    redirect(back(res.ok ? { saved: "1" } : { error: res.error.code === "conflict" ? "conflict" : "invalid" }));
  }

  async function pullNow(form: FormData) {
    "use server";
    const days = Math.min(90, Math.max(1, Math.round(Number(form.get("days") ?? 4)) || 4));
    const res = await pullAdsNow({ days });
    redirect(back(res.ok ? { queued: String(res.data.jobIds.length) } : { error: "pull" }));
  }

  return (
    <div className="grid gap-6" data-testid="ads-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{tr("ops.ads.title")}</h1>
        <a href={`${BASE}/csv?${query}`} className="text-sm font-medium underline-offset-4 hover:underline" download>
          {tr("ops.common.download_csv")}
        </a>
      </div>
      <p className="text-sm text-muted-foreground">{tr("ops.ads.intro")}</p>
      <p className="text-sm" data-testid="ads-data-as-of">
        {r.dataAsOf ? tr("ops.common.data_as_of", { date: formatDate(r.dataAsOf, ctx.locale) }) : tr("ops.attribution.data_as_of_none")}
      </p>
      {sp.saved ? <Alert>{tr("ops.ads.accounts.saved")}</Alert> : null}
      {sp.queued ? <Alert>{Number(sp.queued) > 0 ? tr("ops.ads.pull.queued", { count: Number(sp.queued) }) : tr("ops.ads.pull.none")}</Alert> : null}
      {sp.error ? <Alert variant="destructive">{tr(sp.error === "conflict" ? "ops.ads.accounts.conflict" : sp.error === "pull" ? "ops.ads.pull.failed" : "ops.ads.accounts.invalid")}</Alert> : null}

      <form method="get" action={BASE} className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          {tr("ops.common.from")}
          <input type="date" name="from" defaultValue={r.range.from} className="rounded-md border bg-background px-2 py-1" />
        </label>
        <label className="grid gap-1 text-sm">
          {tr("ops.common.to")}
          <input type="date" name="to" defaultValue={r.range.to} className="rounded-md border bg-background px-2 py-1" />
        </label>
        <Button type="submit" variant="outline" size="sm">
          {tr("ops.common.apply")}
        </Button>
      </form>

      {noAccounts ? (
        <EmptyState title={tr("ops.ads.empty")} />
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label={tr("ops.ads.totals")}>
            {(
              [
                ["spend", money(r.totals.spendCents)],
                ["impressions", count(r.totals.impressions)],
                ["clicks", count(r.totals.clicks)],
                ["platform_leads", count(r.totals.leads)],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="grid gap-1 rounded-lg border p-3" data-testid={`ads-total-${k}`}>
                <span className="text-sm text-muted-foreground">{tr(`ops.ads.column.${k}`)}</span>
                <span className="text-xl font-semibold tabular-nums">{v}</span>
              </div>
            ))}
          </section>

          {r.campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">{tr("ops.ads.no_rows")}</p>
          ) : (
            <>
              <section className="grid gap-2">
                <h2 className="text-lg font-semibold">{tr("ops.ads.by_campaign")}</h2>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tr("ops.ads.column.platform")}</TableHead>
                      <TableHead>{tr("ops.ads.column.campaign")}</TableHead>
                      <TableHead className="text-right">{tr("ops.ads.column.spend")}</TableHead>
                      <TableHead className="text-right">{tr("ops.ads.column.impressions")}</TableHead>
                      <TableHead className="text-right">{tr("ops.ads.column.clicks")}</TableHead>
                      <TableHead className="text-right">{tr("ops.ads.column.platform_leads")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.campaigns.map((c) => (
                      <TableRow key={`${c.platform}:${c.campaignId}`} data-campaign-id={c.campaignId}>
                        <TableCell>{tr(`ops.ads.platform.${c.platform}`)}</TableCell>
                        <TableCell>
                          {c.campaignName}
                          <span className="block text-xs text-muted-foreground">{c.campaignId}</span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(c.spendCents)}</TableCell>
                        <TableCell className="text-right tabular-nums">{count(c.impressions)}</TableCell>
                        <TableCell className="text-right tabular-nums">{count(c.clicks)}</TableCell>
                        <TableCell className="text-right tabular-nums">{count(c.leads)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </section>
              <section className="grid gap-2">
                <h2 className="text-lg font-semibold">{tr("ops.ads.by_day")}</h2>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tr("ops.ads.column.day")}</TableHead>
                      <TableHead>{tr("ops.ads.column.campaign")}</TableHead>
                      <TableHead className="text-right">{tr("ops.ads.column.spend")}</TableHead>
                      <TableHead className="text-right">{tr("ops.ads.column.impressions")}</TableHead>
                      <TableHead className="text-right">{tr("ops.ads.column.clicks")}</TableHead>
                      <TableHead className="text-right">{tr("ops.ads.column.platform_leads")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {r.days.map((d) => (
                      <TableRow key={`${d.platform}:${d.campaignId}:${d.dayOn}`}>
                        <TableCell>{formatDate(d.dayOn, ctx.locale)}</TableCell>
                        <TableCell>{d.campaignName}</TableCell>
                        <TableCell className="text-right tabular-nums">{money(d.spendCents)}</TableCell>
                        <TableCell className="text-right tabular-nums">{count(d.impressions)}</TableCell>
                        <TableCell className="text-right tabular-nums">{count(d.clicks)}</TableCell>
                        <TableCell className="text-right tabular-nums">{count(d.leads)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {r.more ? <p className="text-sm text-muted-foreground">{tr("ops.ads.more")}</p> : null}
              </section>
            </>
          )}
        </>
      )}

      <section className="grid gap-2" data-testid="ads-accounts">
        <h2 className="text-lg font-semibold">{tr("ops.ads.accounts.title")}</h2>
        {r.accounts.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tr("ops.ads.column.platform")}</TableHead>
                <TableHead>{tr("ops.ads.column.account")}</TableHead>
                <TableHead>{tr("ops.ads.column.last_pull")}</TableHead>
                <TableHead>{tr("ops.ads.column.last_day")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.accounts.map((a) => (
                <TableRow key={`${a.platform}:${a.accountId}`}>
                  <TableCell>{tr(`ops.ads.platform.${a.platform}`)}</TableCell>
                  <TableCell>
                    {a.accountId} {a.configured ? null : <Badge variant="secondary">{tr("ops.ads.not_configured")}</Badge>}
                  </TableCell>
                  <TableCell>
                    {a.lastPulledAt ? formatDateTime(a.lastPulledAt, ctx.locale) : tr("ops.ads.never")}{" "}
                    {a.configured && stale(a.lastPulledAt) ? <Badge variant="destructive">{tr("ops.ads.stale")}</Badge> : null}
                  </TableCell>
                  <TableCell>{a.lastDay ? formatDate(a.lastDay, ctx.locale) : "-"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
        {canEdit ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <form action={saveAccounts} className="grid gap-3 rounded-lg border p-4" data-testid="ads-accounts-form">
              <input type="hidden" name="version" value={version} />
              <label className="grid gap-1 text-sm">
                {tr("ops.ads.accounts.meta_ids")}
                <textarea name="meta_account_ids" rows={3} defaultValue={r.settings.meta_account_ids.join("\n")} className="rounded-md border bg-background px-2 py-1 font-mono text-sm" />
              </label>
              <label className="grid gap-1 text-sm">
                {tr("ops.ads.accounts.google_ids")}
                <textarea name="google_customer_ids" rows={3} defaultValue={r.settings.google_customer_ids.join("\n")} className="rounded-md border bg-background px-2 py-1 font-mono text-sm" />
              </label>
              <Button type="submit" size="sm" className="justify-self-start">
                {tr("ops.ads.accounts.save")}
              </Button>
            </form>
            <form action={pullNow} className="grid content-start gap-3 rounded-lg border p-4" data-testid="ads-pull-form">
              <h3 className="font-medium">{tr("ops.ads.pull.title")}</h3>
              <label className="grid gap-1 text-sm">
                {tr("ops.ads.pull.days")}
                <input type="number" name="days" min={1} max={90} defaultValue={4} className="w-24 rounded-md border bg-background px-2 py-1" />
              </label>
              <Button type="submit" size="sm" variant="outline" className="justify-self-start" disabled={noAccounts}>
                {tr("ops.ads.pull.submit")}
              </Button>
            </form>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{tr("ops.ads.accounts.read_only")}</p>
        )}
      </section>
    </div>
  );
}

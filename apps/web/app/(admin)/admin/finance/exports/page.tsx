import type { Route } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cn } from "@beam/ui";
import { FINANCE_EXPORT_KINDS, type FinanceExportKind } from "@beam/core/finance";
import { formatDate, formatDateTime, formatNumber } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { requestFinanceExport } from "@/modules/finance/actions";
import { listFinanceExports } from "@/modules/finance/queries";
import { brusselsDay } from "@/modules/finance/service/billit-sync";
import { EXPORT_PRESETS, exportPresets, periodError } from "@/modules/finance/service/exports";
import { financeLabels } from "@/modules/finance/ui/labels";
import { actionErrorText, fillLabel } from "@/modules/finance/ui/text";
import { PageHeader, Segmented, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { fieldClass, Notice } from "@/modules/platform/ui/admin-list-kit";

/** Every accountant kind (rules 42 and 43): the V1 CSVs, then deferred revenue, breakage and voucher redemptions. */
const isExportKind = (v: unknown): v is FinanceExportKind => typeof v === "string" && (FINANCE_EXPORT_KINDS as readonly string[]).includes(v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The kinds whose figures `/admin/finance/deferred` also shows on screen. */
const ON_SCREEN: readonly FinanceExportKind[] = ["deferred_revenue", "breakage", "voucher_redemptions"];

const STATUS_TONE: Record<string, Tone> = { queued: "muted", running: "info", done: "ok", failed: "bad" };

/** The form's server action: queues the export of the clicked file, then reloads the page with the outcome. */
async function onRequest(form: FormData) {
  "use server";
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const kind = field("kind");
  const from = field("from");
  const to = field("to");
  const back = `kind=${encodeURIComponent(kind)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  if (!isExportKind(kind)) redirect(`/admin/finance/exports?error=finance.errors.period_invalid&${back}`);
  const r = await requestFinanceExport({ kind, from, to });
  if (r.ok) redirect(`/admin/finance/exports?requested=1&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const key = r.error.message.startsWith("finance.errors.") ? r.error.message : (Object.values(r.error.fields ?? {}).find((v) => v.startsWith("finance.errors.")) ?? r.error.code);
  redirect(`/admin/finance/exports?error=${encodeURIComponent(key)}&${back}`);
}

/**
 * `/admin/finance/exports` (`reports.finance`, finance spec section 5, rule 42; "Export
 * boekhouder" in the menu): one period (presets last month, last quarter and last year, or two
 * dates, at most 366 days) and one row per accountant file with a line on what it holds, its last
 * export and an Export button; below, the last 50 exports with status, rows, expiry and download.
 */
export default async function FinanceExportsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; from?: string; to?: string; requested?: string; error?: string }>;
}) {
  const actor = await requireStaff();
  if (!hasPermission(actor, "reports.finance")) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const labels = financeLabels(locale, ["common", "exports"]);
  const l = (key: string, p?: Record<string, string | number>) => fillLabel(labels[key] ?? key, p);
  const presets = exportPresets(brusselsDay(new Date()));
  const chosen = isExportKind(sp.kind) ? sp.kind : null;
  const from = sp.from && DAY.test(sp.from) ? sp.from : presets.last_month.from;
  const to = sp.to && DAY.test(sp.to) ? sp.to : presets.last_month.to;
  const rows = await listFinanceExports(await getAppDb());
  const errorText = sp.error ? actionErrorText(labels, { code: sp.error.startsWith("finance.errors.") ? "conflict" : sp.error, message: sp.error }) : null;
  const periodHint = periodError(from, to);
  const period = (a: string, b: string) => l("exports.period", { from: formatDate(a, locale), to: formatDate(b, locale) });
  const download = (r: (typeof rows)[number]) =>
    r.downloadable ? (
      <a href={`/admin/finance/exports/${r.id}`} download className="font-semibold text-[#8a5a14] hover:underline">
        {l("exports.download")}
      </a>
    ) : null;

  return (
    <div className="grid gap-4">
      <PageHeader title={tr("platform.nav.accountant_export")} description={l("exports.intro")} />

      <div aria-live="polite" role="status" className="empty:hidden">
        {sp.requested === "1" ? <Notice tone="ok">{l("exports.requested")}</Notice> : null}
        {errorText ? <Notice tone="bad">{errorText}</Notice> : null}
      </div>

      <form action={onRequest} className="grid gap-4">
        <Toolbar>
          <Segmented
            label={l("exports.presets")}
            items={EXPORT_PRESETS.map((p) => ({
              key: p,
              label: l(`exports.preset_${p}`),
              href: `/admin/finance/exports?from=${presets[p].from}&to=${presets[p].to}` as Route,
              active: presets[p].from === from && presets[p].to === to,
            }))}
          />
          <label className="flex items-center gap-2 text-[0.8125rem]">
            <span className="text-muted-foreground">{l("exports.from")}</span>
            <input key={`from-${from}`} id="export-from" name="from" type="date" required defaultValue={from} aria-describedby="export-period-hint" className={cn(fieldClass, "w-40")} />
          </label>
          <label className="flex items-center gap-2 text-[0.8125rem]">
            <span className="text-muted-foreground">{l("exports.to")}</span>
            <input key={`to-${to}`} id="export-to" name="to" type="date" required defaultValue={to} aria-describedby="export-period-hint" className={cn(fieldClass, "w-40")} />
          </label>
          <span id="export-period-hint" className={cn("text-[0.75rem]", periodHint ? "font-semibold text-[var(--status-bad)]" : "text-muted-foreground")}>
            {periodHint ? actionErrorText(labels, { code: "validation", message: periodHint }) : l("exports.max_period")}
          </span>
        </Toolbar>

        <Surface flush data-testid="exports-files">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-[0.8125rem]">
              <caption className="sr-only">{l("exports.files_caption")}</caption>
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={th}>{l("exports.col_file")}</th>
                  <th scope="col" className={cn(th, "w-72")}>{l("exports.col_last")}</th>
                  <th scope="col" className={cn(th, "w-32 text-right")}>
                    <span className="sr-only">{l("exports.submit")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {FINANCE_EXPORT_KINDS.map((k) => {
                  const last = rows.find((r) => r.kind === k);
                  return (
                    <tr key={k} className={cn("border-b border-border last:border-b-0", chosen === k && "bg-[#fcfbf9]")} data-export-kind={k}>
                      <td className={td}>
                        <span className="grid gap-0.5">
                          <span className="font-semibold">{l(`exports.kind_${k}`)}</span>
                          <span className="text-[0.75rem] text-muted-foreground">
                            {l(`exports.desc_${k}`)}
                            {ON_SCREEN.includes(k) ? (
                              <>
                                {" "}
                                <Link href="/admin/finance/deferred" className="font-semibold text-[#8a5a14] hover:underline">
                                  {l("exports.view_screen")}
                                </Link>
                              </>
                            ) : null}
                          </span>
                        </span>
                      </td>
                      <td className={td}>
                        {last ? (
                          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <StatusPill tone={STATUS_TONE[last.status] ?? "muted"}>{l(`exports.status_${last.status}`)}</StatusPill>
                            <span className="text-[0.75rem] text-muted-foreground">{period(last.periodFrom, last.periodTo)}</span>
                            {download(last)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{l("common.none")}</span>
                        )}
                      </td>
                      <td className={cn(td, "text-right")}>
                        <button
                          type="submit"
                          name="kind"
                          value={k}
                          aria-label={`${l("exports.export")}: ${l(`exports.kind_${k}`)}`}
                          className={cn(
                            "inline-flex h-8 items-center rounded-lg px-3 text-[0.8125rem] font-semibold",
                            chosen === k ? "bg-primary text-primary-foreground hover:opacity-90" : "border border-border bg-card hover:bg-muted",
                          )}
                        >
                          {l("exports.export")}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Surface>
      </form>

      {rows.length ? (
        <section className="grid gap-2">
          <h2 className="text-[0.9375rem] font-semibold">{l("exports.history")}</h2>
          <Surface flush>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[52rem] text-[0.8125rem]">
                <caption className="sr-only">{l("exports.caption")}</caption>
                <thead className="bg-[#faf9f6]">
                  <tr className="border-b border-border">
                    <th scope="col" className={th}>{l("exports.col_kind")}</th>
                    <th scope="col" className={th}>{l("exports.col_period")}</th>
                    <th scope="col" className={cn(th, "w-28")}>{l("exports.col_status")}</th>
                    <th scope="col" className={cn(th, "w-20 text-right")}>{l("exports.col_rows")}</th>
                    <th scope="col" className={cn(th, "w-40")}>{l("exports.col_requested")}</th>
                    <th scope="col" className={cn(th, "w-40")}>{l("exports.col_expires")}</th>
                    <th scope="col" className={cn(th, "w-28")}>{l("exports.col_download")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-b-0">
                      <td className={cn(td, "font-medium")}>{l(`exports.kind_${r.kind}`)}</td>
                      <td className={cn(td, "whitespace-nowrap")}>{period(r.periodFrom, r.periodTo)}</td>
                      <td className={td}>
                        <StatusPill tone={STATUS_TONE[r.status] ?? "muted"}>{l(`exports.status_${r.status}`)}</StatusPill>
                        {r.status === "failed" && r.error ? <span className="block text-[0.75rem] text-[var(--status-bad)]">{actionErrorText(labels, { code: "conflict", message: r.error })}</span> : null}
                      </td>
                      <td className={cn(td, "text-right tabular-nums")}>{r.rowCount === null ? l("common.none") : formatNumber(r.rowCount, locale)}</td>
                      <td className={td}>
                        <span className="grid leading-tight">
                          <span className="whitespace-nowrap">{formatDateTime(r.createdAt, locale)}</span>
                          {r.requestedBy ? <span className="text-[0.75rem] text-muted-foreground">{r.requestedBy}</span> : null}
                        </span>
                      </td>
                      <td className={cn(td, "whitespace-nowrap")}>{r.expiresAt ? (r.downloadable ? formatDateTime(r.expiresAt, locale) : l("exports.expired")) : l("common.none")}</td>
                      <td className={td}>{download(r) ?? <span className="text-muted-foreground">{l("common.none")}</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Surface>
        </section>
      ) : null}
    </div>
  );
}

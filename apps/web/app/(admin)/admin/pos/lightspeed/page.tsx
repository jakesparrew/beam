import { notFound, redirect } from "next/navigation";
import { Button, cn, Input } from "@beam/ui";
import { formatDate, formatDateTime, formatMoney, t } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { uploadLightspeedCsv } from "@/modules/commerce/actions";
import { businessDayOf } from "@/modules/commerce/queries";
import { LIGHTSPEED_MAX_BYTES, getLightspeedDaily, listLightspeedImports } from "@/modules/commerce/queries";
import { PageHeader, StatusPill, Surface, Toolbar, td, th, type Tone } from "@/modules/platform/ui/admin-kit";
import { BackLink, fieldClass, Notice } from "@/modules/platform/ui/admin-list-kit";

type Search = Record<string, string | undefined>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_TONE: Record<string, Tone> = { uploaded: "muted", running: "info", done: "ok", failed: "bad" };

/** `day` minus `n` calendar days (`YYYY-MM-DD`, no time zone involved). */
function daysBefore(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

/**
 * `/admin/pos/lightspeed` (commerce spec 5.1, rule 53, R3): the Lightspeed food-and-drink import.
 * Staff with `commerce.sell` upload the daily sales CSV exported from the Lightspeed back office;
 * the list shows every import with its status, period and counts, and the rows it could not
 * read. Staff with `reports.finance` see the daily totals by category (`v_lightspeed_daily`).
 * A one-off import, out of the menu (owner review November 2026): linked from the day close.
 */
export default async function LightspeedPage({ searchParams }: { searchParams: Promise<Search> }) {
  const actor = await requireStaff();
  const canUpload = hasPermission(actor, "commerce.sell");
  const canView = hasPermission(actor, "reports.finance");
  if (!canUpload && !canView) notFound();
  const sp = await searchParams;
  const locale = await adminLocale();
  const tr = translator(locale);
  const c = (k: string, p?: Record<string, string | number>) => tr(`commerce.lightspeed.${k}`, p);
  const errorText = (code: string) =>
    t.has(locale, `commerce.lightspeed.error_${code}`) ? c(`error_${code}`) : t.has(locale, `commerce.errors.${code}`) ? tr(`commerce.errors.${code}`) : tr("commerce.common.error");
  const rowError = (code: string) => (t.has(locale, `commerce.lightspeed.row_${code}`) ? c(`row_${code}`) : code);
  const money = (n: number) => formatMoney(n, locale);

  const today = businessDayOf(new Date());
  const to = sp.to && DAY.test(sp.to) ? sp.to : today;
  const from = sp.from && DAY.test(sp.from) && sp.from <= to ? sp.from : daysBefore(to, 30);
  const db = await getAppDb();
  const [imports, daily] = await Promise.all([listLightspeedImports(db, { limit: 50 }), canView ? getLightspeedDaily(db, { from, to }) : Promise.resolve([])]);
  const totals = daily.reduce((s, r) => ({ total: s.total + r.totalCents, vat: s.vat + r.vatCents }), { total: 0, vat: 0 });

  async function onUpload(form: FormData) {
    "use server";
    const r = await uploadLightspeedCsv(form);
    const q = new URLSearchParams(r.ok ? { uploaded: "1" } : { error: r.error.fields?.file ?? r.error.message });
    redirect(`/admin/pos/lightspeed?${q.toString()}` as never);
  }

  return (
    <div className="grid max-w-5xl gap-4">
      {canUpload ? <BackLink href="/admin/pos/day">{tr("commerce.nav.pos_day")}</BackLink> : null}
      <PageHeader title={c("title")} description={c("intro")} />

      <div role="status" aria-live="polite" className="grid gap-2 empty:hidden">
        {sp.error ? <Notice tone="bad">{c("upload_failed", { message: errorText(sp.error) })}</Notice> : null}
        {sp.uploaded ? <Notice tone="ok">{c("uploaded")}</Notice> : null}
      </div>

      {canUpload ? (
        <Surface aria-labelledby="lightspeed-upload" className="grid gap-2 p-4">
          <h2 id="lightspeed-upload" className="text-[0.9375rem] font-semibold">
            {c("upload_title")}
          </h2>
          <p className="text-[0.75rem] text-muted-foreground">{c("upload_hint", { size: Math.round(LIGHTSPEED_MAX_BYTES / 1024 / 1024) })}</p>
          <form action={onUpload} className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-[0.8125rem]">
              <span>{c("file")}</span>
              <Input type="file" name="file" accept=".csv,text/csv" required className="h-11 w-80" />
            </label>
            <Button type="submit" className="min-h-11">
              {c("upload")}
            </Button>
          </form>
        </Surface>
      ) : null}

      <section aria-labelledby="lightspeed-imports" className="grid gap-2">
        <h2 id="lightspeed-imports" className="text-[0.9375rem] font-semibold">
          {c("imports_title")}
        </h2>
        {imports.length === 0 ? (
          <Notice tone="muted">{c("empty")}</Notice>
        ) : (
          <Surface flush>
          <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] text-[0.8125rem]">
            <thead className="bg-[#faf9f6]">
              <tr className="border-b border-border">
                <th scope="col" className={cn(th, "w-40")}>{c("col_uploaded")}</th>
                <th scope="col" className={th}>{c("col_file")}</th>
                <th scope="col" className={cn(th, "w-24")}>{c("col_status")}</th>
                <th scope="col" className={cn(th, "w-48")}>{c("col_period")}</th>
                <th scope="col" className={cn(th, "w-20 text-right")}>{c("col_rows")}</th>
                <th scope="col" className={cn(th, "w-24 text-right")}>{c("col_imported")}</th>
                <th scope="col" className={cn(th, "w-24 text-right")}>{c("col_skipped")}</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => (
                <tr key={imp.id} className="border-b border-border align-top last:border-b-0">
                  <td className={cn(td, "whitespace-nowrap")}>{formatDateTime(imp.createdAt, locale, "short")}</td>
                  <td className={td}>
                    <span className="break-all">{imp.fileName}</span>
                    {imp.errors.length ? (
                      <details className="mt-1 text-xs text-muted-foreground">
                        <summary>{c("errors_count", { count: imp.errors.length })}</summary>
                        <ul className="mt-1 grid gap-0.5">
                          {imp.errors.slice(0, 50).map((e, i) => (
                            <li key={`${e.row}-${e.code}-${i}`}>{e.row > 0 ? c("error_row", { row: e.row, message: rowError(e.code) }) : rowError(e.code)}</li>
                          ))}
                        </ul>
                      </details>
                    ) : null}
                  </td>
                  <td className={td}>
                    <StatusPill tone={STATUS_TONE[imp.status] ?? "muted"}>{c(`status_${imp.status}`)}</StatusPill>
                  </td>
                  <td className={cn(td, "whitespace-nowrap")}>
                    {imp.businessFromOn && imp.businessToOn
                      ? imp.businessFromOn === imp.businessToOn
                        ? formatDate(imp.businessFromOn, locale, "medium")
                        : c("period", { from: formatDate(imp.businessFromOn, locale, "medium"), to: formatDate(imp.businessToOn, locale, "medium") })
                      : "–"}
                  </td>
                  <td className={cn(td, "text-right tabular-nums")}>{imp.rowsTotal}</td>
                  <td className={cn(td, "text-right tabular-nums")}>{imp.rowsImported}</td>
                  <td className={cn(td, "text-right tabular-nums", imp.rowsSkipped > 0 && "text-[var(--status-warn)]")}>{imp.rowsSkipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          </Surface>
        )}
      </section>

      {canView ? (
        <section aria-labelledby="lightspeed-daily" className="grid gap-2">
          <h2 id="lightspeed-daily" className="text-[0.9375rem] font-semibold">
            {c("daily_title")}
          </h2>
          <form data-auto-filter="" method="get">
            <Toolbar>
              <label className="flex items-center gap-2 text-[0.8125rem]">
                <span className="text-muted-foreground">{c("from")}</span>
                <input type="date" name="from" defaultValue={from} max={to} className={cn(fieldClass, "w-40")} />
              </label>
              <label className="flex items-center gap-2 text-[0.8125rem]">
                <span className="text-muted-foreground">{c("to")}</span>
                <input type="date" name="to" defaultValue={to} className={cn(fieldClass, "w-40")} />
              </label>
            </Toolbar>
          </form>
          {daily.length === 0 ? (
            <Notice tone="muted">{c("daily_empty")}</Notice>
          ) : (
            <Surface flush>
            <table className="w-full text-[0.8125rem]">
              <thead className="bg-[#faf9f6]">
                <tr className="border-b border-border">
                  <th scope="col" className={cn(th, "w-40")}>{c("col_day")}</th>
                  <th scope="col" className={th}>{c("col_category")}</th>
                  <th scope="col" className={cn(th, "w-32 text-right")}>{c("col_total")}</th>
                  <th scope="col" className={cn(th, "w-28 text-right")}>{c("col_vat")}</th>
                  <th scope="col" className={cn(th, "w-24 text-right")}>{c("col_receipts")}</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((r) => (
                  <tr key={`${r.businessDayOn}-${r.category}`} className="border-b border-border">
                    <td className={cn(td, "whitespace-nowrap")}>{formatDate(r.businessDayOn, locale, "medium")}</td>
                    <td className={td}>{r.category}</td>
                    <td className={cn(td, "text-right font-semibold tabular-nums")}>{money(r.totalCents)}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{money(r.vatCents)}</td>
                    <td className={cn(td, "text-right tabular-nums")}>{r.receipts}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-[#fcfbf9]">
                <tr>
                  <th scope="row" colSpan={2} className={cn(td, "text-left font-semibold")}>
                    {c("total")}
                  </th>
                  <td className={cn(td, "text-right font-semibold tabular-nums")}>{money(totals.total)}</td>
                  <td className={cn(td, "text-right font-semibold tabular-nums")}>{money(totals.vat)}</td>
                  <td className={td} />
                </tr>
              </tfoot>
            </table>
            </Surface>
          )}
        </section>
      ) : null}
    </div>
  );
}

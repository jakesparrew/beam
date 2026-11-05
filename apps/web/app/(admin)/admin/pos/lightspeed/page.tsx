import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Badge, Button, Input } from "@beam/ui";
import { formatDate, formatDateTime, formatMoney, t } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { uploadLightspeedCsv } from "@/modules/commerce/actions";
import { businessDayOf } from "@/modules/commerce/queries";
import { LIGHTSPEED_MAX_BYTES, getLightspeedDaily, listLightspeedImports } from "@/modules/commerce/server/lightspeed";

type Search = Record<string, string | undefined>;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUS_VARIANT = { uploaded: "outline", running: "secondary", done: "success", failed: "destructive" } as const;

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
    <div className="grid max-w-5xl gap-6">
      <header className="grid gap-1">
        <Link href="/admin/pos" className="text-sm underline">
          {c("back_to_pos")}
        </Link>
        <h1 className="text-2xl font-semibold">{c("title")}</h1>
        <p className="text-sm text-muted-foreground">{c("intro")}</p>
      </header>

      <div role="status" aria-live="polite">
        {sp.error ? <p className="rounded-md border border-destructive p-3 text-sm">{c("upload_failed", { message: errorText(sp.error) })}</p> : null}
        {sp.uploaded ? <p className="rounded-md border p-3 text-sm">{c("uploaded")}</p> : null}
      </div>

      {canUpload ? (
        <section aria-labelledby="lightspeed-upload" className="grid gap-2 rounded-md border p-4">
          <h2 id="lightspeed-upload" className="text-lg font-semibold">
            {c("upload_title")}
          </h2>
          <p className="text-sm text-muted-foreground">{c("upload_hint", { size: Math.round(LIGHTSPEED_MAX_BYTES / 1024 / 1024) })}</p>
          <form action={onUpload} className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-sm">
              <span>{c("file")}</span>
              <Input type="file" name="file" accept=".csv,text/csv" required className="h-11 w-80" />
            </label>
            <Button type="submit" className="min-h-11">
              {c("upload")}
            </Button>
          </form>
        </section>
      ) : null}

      <section aria-labelledby="lightspeed-imports" className="grid gap-2">
        <h2 id="lightspeed-imports" className="text-lg font-semibold">
          {c("imports_title")}
        </h2>
        {imports.length === 0 ? (
          <p className="text-sm text-muted-foreground">{c("empty")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-1">{c("col_uploaded")}</th>
                <th scope="col" className="py-1">{c("col_file")}</th>
                <th scope="col" className="py-1">{c("col_status")}</th>
                <th scope="col" className="py-1">{c("col_period")}</th>
                <th scope="col" className="py-1 text-right">{c("col_rows")}</th>
                <th scope="col" className="py-1 text-right">{c("col_imported")}</th>
                <th scope="col" className="py-1 text-right">{c("col_skipped")}</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((imp) => (
                <tr key={imp.id} className="border-b align-top">
                  <td className="py-2">{formatDateTime(imp.createdAt, locale, "short")}</td>
                  <td className="py-2">
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
                  <td className="py-2">
                    <Badge variant={STATUS_VARIANT[imp.status]}>{c(`status_${imp.status}`)}</Badge>
                  </td>
                  <td className="py-2">
                    {imp.businessFromOn && imp.businessToOn
                      ? imp.businessFromOn === imp.businessToOn
                        ? formatDate(imp.businessFromOn, locale, "medium")
                        : c("period", { from: formatDate(imp.businessFromOn, locale, "medium"), to: formatDate(imp.businessToOn, locale, "medium") })
                      : "–"}
                  </td>
                  <td className="py-2 text-right tabular-nums">{imp.rowsTotal}</td>
                  <td className="py-2 text-right tabular-nums">{imp.rowsImported}</td>
                  <td className="py-2 text-right tabular-nums">{imp.rowsSkipped}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {canView ? (
        <section aria-labelledby="lightspeed-daily" className="grid gap-2">
          <h2 id="lightspeed-daily" className="text-lg font-semibold">
            {c("daily_title")}
          </h2>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-sm">
              <span>{c("from")}</span>
              <Input type="date" name="from" defaultValue={from} max={to} className="h-11 w-48" />
            </label>
            <label className="grid gap-1 text-sm">
              <span>{c("to")}</span>
              <Input type="date" name="to" defaultValue={to} className="h-11 w-48" />
            </label>
            <Button type="submit" variant="outline" className="min-h-11">
              {c("show")}
            </Button>
          </form>
          {daily.length === 0 ? (
            <p className="text-sm text-muted-foreground">{c("daily_empty")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th scope="col" className="py-1">{c("col_day")}</th>
                  <th scope="col" className="py-1">{c("col_category")}</th>
                  <th scope="col" className="py-1 text-right">{c("col_total")}</th>
                  <th scope="col" className="py-1 text-right">{c("col_vat")}</th>
                  <th scope="col" className="py-1 text-right">{c("col_receipts")}</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((r) => (
                  <tr key={`${r.businessDayOn}-${r.category}`} className="border-b">
                    <td className="py-2">{formatDate(r.businessDayOn, locale, "medium")}</td>
                    <td className="py-2">{r.category}</td>
                    <td className="py-2 text-right tabular-nums">{money(r.totalCents)}</td>
                    <td className="py-2 text-right tabular-nums">{money(r.vatCents)}</td>
                    <td className="py-2 text-right tabular-nums">{r.receipts}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={2} className="py-2 text-left">
                    {c("total")}
                  </th>
                  <td className="py-2 text-right font-semibold tabular-nums">{money(totals.total)}</td>
                  <td className="py-2 text-right font-semibold tabular-nums">{money(totals.vat)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
        </section>
      ) : null}
    </div>
  );
}

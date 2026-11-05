import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  Badge,
  Button,
  buttonVariants,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@beam/ui";
import { FINANCE_EXPORT_KINDS, type FinanceExportKind } from "@beam/core/finance";
import { formatDate, formatDateTime, formatNumber } from "@beam/core/i18n";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { requestFinanceExport } from "@/modules/finance/actions";
import { listFinanceExports } from "@/modules/finance/queries";
import { brusselsDay } from "@/modules/finance/service/billit-sync";
import { EXPORT_PRESETS, exportPresets, periodError } from "@/modules/finance/service/exports";
import { financeLabels } from "@/modules/finance/ui/labels";
import { actionErrorText, fillLabel } from "@/modules/finance/ui/text";

/** Every accountant kind (rules 42 and 43): the V1 CSVs, then deferred revenue, breakage and voucher redemptions. */
const isExportKind = (v: unknown): v is FinanceExportKind => typeof v === "string" && (FINANCE_EXPORT_KINDS as readonly string[]).includes(v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_VARIANT = { queued: "secondary", running: "warning", done: "success", failed: "destructive" } as const;

/** The form's server action: queues the export, then reloads the page with the outcome. */
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
  if (r.ok) redirect("/admin/finance/exports?requested=1");
  const key = r.error.message.startsWith("finance.errors.") ? r.error.message : (Object.values(r.error.fields ?? {}).find((v) => v.startsWith("finance.errors.")) ?? r.error.code);
  redirect(`/admin/finance/exports?error=${encodeURIComponent(key)}&${back}`);
}

/**
 * `/admin/finance/exports` (`reports.finance`, finance spec section 5, rule 42): request an
 * accountant CSV (kind and period, presets last month, last quarter and last year; at most 366
 * days) and the last 50 exports with status, rows and expiry, with their download links.
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
  const labels = financeLabels(locale, ["common", "exports"]);
  const l = (key: string, p?: Record<string, string | number>) => fillLabel(labels[key] ?? key, p);
  const presets = exportPresets(brusselsDay(new Date()));
  const kind: FinanceExportKind = isExportKind(sp.kind) ? sp.kind : "invoices";
  const from = sp.from && DAY.test(sp.from) ? sp.from : presets.last_month.from;
  const to = sp.to && DAY.test(sp.to) ? sp.to : presets.last_month.to;
  const rows = await listFinanceExports(await getAppDb());
  const errorText = sp.error ? actionErrorText(labels, { code: sp.error.startsWith("finance.errors.") ? "conflict" : sp.error, message: sp.error }) : null;
  const periodHint = periodError(from, to);

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">{l("exports.title")}</h1>
        <p className="text-sm text-muted-foreground">{l("exports.intro")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{l("exports.form_title")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <nav aria-label={l("exports.presets")} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{l("exports.presets")}:</span>
            {EXPORT_PRESETS.map((p) => {
              const active = presets[p].from === from && presets[p].to === to;
              return (
                <Link
                  key={p}
                  href={`/admin/finance/exports?kind=${kind}&from=${presets[p].from}&to=${presets[p].to}`}
                  className={buttonVariants({ variant: active ? "secondary" : "outline", size: "sm" })}
                  aria-current={active ? "true" : undefined}
                >
                  {l(`exports.preset_${p}`)}
                </Link>
              );
            })}
          </nav>
          <form action={onRequest} className="grid gap-4 sm:grid-cols-[minmax(12rem,1fr)_auto_auto_auto] sm:items-end">
            <div className="grid gap-1.5">
              <Label htmlFor="export-kind">{l("exports.kind")}</Label>
              <select
                id="export-kind"
                name="kind"
                defaultValue={kind}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {FINANCE_EXPORT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {l(`exports.kind_${k}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="export-from">{l("exports.from")}</Label>
              <Input id="export-from" name="from" type="date" required defaultValue={from} aria-describedby="export-period-hint" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="export-to">{l("exports.to")}</Label>
              <Input id="export-to" name="to" type="date" required defaultValue={to} aria-describedby="export-period-hint" />
            </div>
            <Button type="submit">{l("exports.submit")}</Button>
          </form>
          <p id="export-period-hint" className={periodHint ? "text-sm font-medium text-destructive" : "text-sm text-muted-foreground"}>
            {periodHint ? actionErrorText(labels, { code: "validation", message: periodHint }) : l("exports.max_period")}
          </p>
          <div aria-live="polite" role="status" className="text-sm">
            {sp.requested === "1" ? <p>{l("exports.requested")}</p> : null}
            {errorText ? <p className="font-medium text-destructive">{errorText}</p> : null}
          </div>
        </CardContent>
      </Card>

      {rows.length === 0 ? (
        <EmptyState title={l("exports.empty")} />
      ) : (
        <Table>
          <TableCaption>{l("exports.caption")}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{l("exports.col_kind")}</TableHead>
              <TableHead>{l("exports.col_period")}</TableHead>
              <TableHead>{l("exports.col_status")}</TableHead>
              <TableHead className="text-right">{l("exports.col_rows")}</TableHead>
              <TableHead>{l("exports.col_requested")}</TableHead>
              <TableHead>{l("exports.col_by")}</TableHead>
              <TableHead>{l("exports.col_expires")}</TableHead>
              <TableHead>{l("exports.col_download")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{l(`exports.kind_${r.kind}`)}</TableCell>
                <TableCell className="whitespace-nowrap">{l("exports.period", { from: formatDate(r.periodFrom, locale), to: formatDate(r.periodTo, locale) })}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[r.status]}>{l(`exports.status_${r.status}`)}</Badge>
                  {r.status === "failed" && r.error ? <span className="block text-sm text-destructive">{actionErrorText(labels, { code: "conflict", message: r.error })}</span> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.rowCount === null ? l("common.none") : formatNumber(r.rowCount, locale)}</TableCell>
                <TableCell className="whitespace-nowrap">{formatDateTime(r.createdAt, locale)}</TableCell>
                <TableCell>{r.requestedBy ?? l("common.none")}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {r.expiresAt ? (r.downloadable ? formatDateTime(r.expiresAt, locale) : l("exports.expired")) : l("common.none")}
                </TableCell>
                <TableCell>
                  {r.downloadable ? (
                    <a href={`/admin/finance/exports/${r.id}`} download className={buttonVariants({ variant: "outline", size: "sm" })}>
                      {l("exports.download")}
                    </a>
                  ) : (
                    l("common.none")
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

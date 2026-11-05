import Link from "next/link";
import { redirect } from "next/navigation";
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
import { formatDate, formatMoney, formatNumber, type Locale } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale } from "@/lib/i18n";
import { requestFinanceExport } from "@/modules/finance/actions";
import { getBreakage, getDeferredRevenue, getVoucherRedemptions, type Money3 } from "@/modules/finance/queries";
import { brusselsDay } from "@/modules/finance/service/billit-sync";
import { periodError } from "@/modules/finance/service/exports";
import { bucketLabel } from "@/modules/finance/ui/dashboard/format";
import { financeLabels } from "@/modules/finance/ui/labels";
import { actionErrorText, fillLabel } from "@/modules/finance/ui/text";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ["day", "night", "euro"] as const;
const EXPORT_KINDS = ["deferred_revenue", "breakage", "voucher_redemptions"] as const;
type R3ExportKind = (typeof EXPORT_KINDS)[number];
/** Redemptions listed on screen; the CSV holds all of them. */
const MAX_VOUCHER_ROWS = 200;

const isR3ExportKind = (v: string): v is R3ExportKind => (EXPORT_KINDS as readonly string[]).includes(v);

/**
 * The export buttons' server action: queues the CSV through `requestFinanceExport` (rule 43,
 * audited as `finance.export_requested`), then reloads the page with the outcome.
 */
async function onExport(form: FormData) {
  "use server";
  const field = (name: string) => {
    const v = form.get(name);
    return typeof v === "string" ? v : "";
  };
  const back = `asOf=${encodeURIComponent(field("asOf"))}&from=${encodeURIComponent(field("periodFrom"))}&to=${encodeURIComponent(field("periodTo"))}`;
  const kind = field("kind");
  if (!isR3ExportKind(kind)) redirect(`/admin/finance/deferred?error=finance.errors.export_kind_unavailable&${back}`);
  const r = await requestFinanceExport({ kind, from: field("from"), to: field("to") });
  if (r.ok) redirect(`/admin/finance/deferred?requested=1&${back}`);
  const key = r.error.message.startsWith("finance.errors.") ? r.error.message : (Object.values(r.error.fields ?? {}).find((v) => v.startsWith("finance.errors.")) ?? r.error.code);
  redirect(`/admin/finance/deferred?error=${encodeURIComponent(key)}&${back}`);
}

function MoneyCells({ m, locale }: { m: Money3; locale: Locale }) {
  return (
    <>
      <TableCell className="text-right tabular-nums">{formatMoney(m.grossCents, locale)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(m.netCents, locale)}</TableCell>
      <TableCell className="text-right tabular-nums">{formatMoney(m.vatCents, locale)}</TableCell>
    </>
  );
}

function ExportButton({ kind, from, to, keep, label }: { kind: R3ExportKind; from: string; to: string; keep: { asOf: string; from: string; to: string }; label: string }) {
  return (
    <form action={onExport}>
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <input type="hidden" name="asOf" value={keep.asOf} />
      <input type="hidden" name="periodFrom" value={keep.from} />
      <input type="hidden" name="periodTo" value={keep.to} />
      <Button type="submit" variant="outline" size="sm">
        {label}
      </Button>
    </form>
  );
}

/**
 * `/admin/finance/deferred` (`reports.finance`, finance spec section 5 and rule 43, R3): unused
 * paid credits on `?asOf=` (default today) by credit kind and by kind, VAT treatment and rate;
 * recognised, breakage and revoked value per month for `?from=&to=` (default this year); euro
 * voucher redemptions of that period with their invoice numbers; and the three accountant CSVs.
 * Without `reports.finance` the page is a 404 (`requireStaff`).
 */
export default async function FinanceDeferredPage({
  searchParams,
}: {
  searchParams: Promise<{ asOf?: string; from?: string; to?: string; requested?: string; error?: string }>;
}) {
  await requireStaff({ permission: "reports.finance" });
  const sp = await searchParams;
  const locale = await adminLocale();
  const labels = financeLabels(locale, ["common", "deferred"]);
  const l = (key: string, p?: Record<string, string | number>) => fillLabel(labels[`deferred.${key}`] ?? labels[key] ?? key, p);
  const db = await getAppDb();

  const today = brusselsDay(new Date());
  const asOfGiven = sp.asOf && DAY.test(sp.asOf) && !Number.isNaN(Date.parse(sp.asOf)) ? sp.asOf : null;
  const asOfInvalid = Boolean(sp.asOf) && !asOfGiven;
  const defaults = { from: `${today.slice(0, 4)}-01-01`, to: today };
  const given = { from: sp.from && DAY.test(sp.from) ? sp.from : defaults.from, to: sp.to && DAY.test(sp.to) ? sp.to : defaults.to };
  const periodInvalid = periodError(given.from, given.to) !== null;
  const period = periodInvalid ? defaults : given;

  let deferred;
  let asOfFallback = asOfInvalid;
  try {
    deferred = await getDeferredRevenue(db, { asOf: asOfGiven ?? today });
  } catch (error) {
    if (!asOfGiven) throw error;
    asOfFallback = true;
    deferred = await getDeferredRevenue(db, { asOf: today });
  }
  const [movements, redemptions] = await Promise.all([getBreakage(db, period), getVoucherRedemptions(db, period)]);
  const shownRedemptions = redemptions.slice(0, MAX_VOUCHER_ROWS);
  const keep = { asOf: deferred.asOf, from: period.from, to: period.to };

  const kindLabel = (k: string) => l(`kind_${k}`);
  const rateLabel = (r: number | null) => (r === null ? l("rate_none") : l("rate_value", { rate: formatNumber(r, locale) }));
  const errorText = sp.error ? actionErrorText(labels, { code: sp.error.startsWith("finance.errors.") ? "conflict" : sp.error, message: sp.error }) : null;
  const hasDeferred = deferred.byRate.some((r) => r.units > 0);

  return (
    <div className="grid gap-6">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold">{l("title")}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{l("intro")}</p>
      </header>

      <form method="get" aria-label={l("filters")} className="grid gap-4 sm:grid-cols-[repeat(3,minmax(10rem,14rem))_auto] sm:items-end">
        <div className="grid gap-1.5">
          <Label htmlFor="deferred-as-of">{l("as_of")}</Label>
          <Input id="deferred-as-of" name="asOf" type="date" required defaultValue={deferred.asOf} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="deferred-from">{l("from")}</Label>
          <Input id="deferred-from" name="from" type="date" required defaultValue={period.from} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="deferred-to">{l("to")}</Label>
          <Input id="deferred-to" name="to" type="date" required defaultValue={period.to} />
        </div>
        <Button type="submit">{l("apply")}</Button>
      </form>
      <div aria-live="polite" role="status" className="grid gap-1 text-sm">
        {asOfFallback ? <p className="font-medium text-destructive">{l("as_of_invalid")}</p> : null}
        {periodInvalid ? <p className="font-medium text-destructive">{l("period_invalid")}</p> : null}
        {sp.requested === "1" ? (
          <p>
            {l("export_requested")}{" "}
            <Link href="/admin/finance/exports" className="underline underline-offset-4">
              {l("open_exports")}
            </Link>
          </p>
        ) : null}
        {errorText ? <p className="font-medium text-destructive">{errorText}</p> : null}
      </div>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1">
            <CardTitle className="text-base">{l("deferred_title", { date: formatDate(deferred.asOf, locale) })}</CardTitle>
            <p className="text-sm text-muted-foreground">{deferred.source === "today" ? l("deferred_today") : l("deferred_past", { date: formatDate(deferred.asOf, locale) })}</p>
          </div>
          <ExportButton kind="deferred_revenue" from={deferred.asOf} to={deferred.asOf} keep={keep} label={l("export_deferred_revenue")} />
        </CardHeader>
        <CardContent className="grid gap-6">
          {!hasDeferred ? (
            <EmptyState title={l("empty")} />
          ) : (
            <>
              <dl className="grid gap-4 sm:grid-cols-3">
                {(["grossCents", "netCents", "vatCents"] as const).map((k) => (
                  <div key={k} className="rounded-lg border p-4">
                    <dt className="text-sm text-muted-foreground">{l(k === "grossCents" ? "gross" : k === "netCents" ? "net" : "vat")}</dt>
                    <dd className="text-2xl font-semibold tabular-nums">{formatMoney(deferred.total[k], locale)}</dd>
                  </div>
                ))}
              </dl>
              <Table>
                <TableCaption>{l("by_kind_caption")}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{l("col_kind")}</TableHead>
                    <TableHead className="text-right">{l("gross")}</TableHead>
                    <TableHead className="text-right">{l("net")}</TableHead>
                    <TableHead className="text-right">{l("vat")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {KINDS.map((k) => (
                    <TableRow key={k}>
                      <TableCell>{kindLabel(k)}</TableCell>
                      <MoneyCells m={deferred.byKind[k]} locale={locale} />
                    </TableRow>
                  ))}
                  <TableRow className="font-medium">
                    <TableCell>{l("total")}</TableCell>
                    <MoneyCells m={deferred.total} locale={locale} />
                  </TableRow>
                </TableBody>
              </Table>
              <Table>
                <TableCaption>{l("by_rate_caption")}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{l("col_kind")}</TableHead>
                    <TableHead>{l("col_treatment")}</TableHead>
                    <TableHead className="text-right">{l("col_rate")}</TableHead>
                    <TableHead className="text-right">{l("units")}</TableHead>
                    <TableHead className="text-right">{l("gross")}</TableHead>
                    <TableHead className="text-right">{l("net")}</TableHead>
                    <TableHead className="text-right">{l("vat")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {deferred.byRate.map((r) => (
                    <TableRow key={`${r.creditKind}-${r.vatTreatment}-${r.vatRatePct ?? "none"}`}>
                      <TableCell>{kindLabel(r.creditKind)}</TableCell>
                      <TableCell>{l(`treatment_${r.vatTreatment}`)}</TableCell>
                      <TableCell className="text-right tabular-nums">{rateLabel(r.vatRatePct)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(r.units, locale)}</TableCell>
                      <MoneyCells m={r} locale={locale} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1">
            <CardTitle className="text-base">{l("movements_title")}</CardTitle>
            <p className="max-w-3xl text-sm text-muted-foreground">{l("movements_intro")}</p>
          </div>
          <ExportButton kind="breakage" from={period.from} to={period.to} keep={keep} label={l("export_breakage")} />
        </CardHeader>
        <CardContent>
          {movements.length === 0 ? (
            <EmptyState title={l("movements_empty")} />
          ) : (
            <Table>
              <TableCaption>{l("movements_caption")}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>{l("col_month")}</TableHead>
                  <TableHead>{l("col_kind")}</TableHead>
                  <TableHead className="text-right">{l("col_rate")}</TableHead>
                  <TableHead className="text-right">{l("col_recognised")}</TableHead>
                  <TableHead className="text-right">{l("col_breakage_gross")}</TableHead>
                  <TableHead className="text-right">{l("col_breakage_net")}</TableHead>
                  <TableHead className="text-right">{l("col_breakage_vat")}</TableHead>
                  <TableHead className="text-right">{l("col_revoked")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movements.map((r) => (
                  <TableRow key={`${r.month}-${r.creditKind}-${r.vatRatePct ?? "none"}`}>
                    <TableCell className="whitespace-nowrap">{bucketLabel(r.month, "month", locale)}</TableCell>
                    <TableCell>{kindLabel(r.creditKind)}</TableCell>
                    <TableCell className="text-right tabular-nums">{rateLabel(r.vatRatePct)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatMoney(r.recognised.grossCents, locale)}</TableCell>
                    <MoneyCells m={r.breakage} locale={locale} />
                    <TableCell className="text-right tabular-nums">{formatMoney(r.revoked.grossCents, locale)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
          <div className="grid gap-1">
            <CardTitle className="text-base">{l("vouchers_title")}</CardTitle>
            <p className="max-w-3xl text-sm text-muted-foreground">{l("vouchers_intro")}</p>
          </div>
          <ExportButton kind="voucher_redemptions" from={period.from} to={period.to} keep={keep} label={l("export_voucher_redemptions")} />
        </CardHeader>
        <CardContent className="grid gap-2">
          {redemptions.length === 0 ? (
            <EmptyState title={l("vouchers_empty")} />
          ) : (
            <>
              {redemptions.length > shownRedemptions.length ? (
                <p className="text-sm text-muted-foreground">{l("vouchers_truncated", { shown: shownRedemptions.length, count: redemptions.length })}</p>
              ) : null}
              <Table>
                <TableCaption>{l("vouchers_caption")}</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{l("col_redeemed_on")}</TableHead>
                    <TableHead>{l("col_order")}</TableHead>
                    <TableHead>{l("col_invoice")}</TableHead>
                    <TableHead className="text-right">{l("col_amount")}</TableHead>
                    <TableHead>{l("col_reversed")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shownRedemptions.map((r, i) => (
                    <TableRow key={`${r.orderId}-${i}`}>
                      <TableCell className="whitespace-nowrap">{formatDate(r.redeemedOn, locale)}</TableCell>
                      <TableCell className="font-mono text-xs">{r.orderId}</TableCell>
                      <TableCell>{r.invoiceNumber ?? <span className="text-muted-foreground">{l("no_invoice")}</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(r.amountCents, locale)}</TableCell>
                      <TableCell>{r.isReversed ? <Badge variant="secondary">{l("reversed")}</Badge> : l("common.none")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <section aria-labelledby="deferred-export-title" className="grid gap-1">
        <h2 id="deferred-export-title" className="text-base font-semibold">
          {l("export_title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {l("export_intro")}{" "}
          <Link href="/admin/finance/exports" className={buttonVariants({ variant: "link", size: "sm" })}>
            {l("open_exports")}
          </Link>
        </p>
      </section>
    </div>
  );
}

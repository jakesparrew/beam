import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  cn,
  EmptyState,
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
import { adminLocale, translator } from "@/lib/i18n";
import { requestFinanceExport } from "@/modules/finance/actions";
import { getBreakage, getDeferredRevenue, getVoucherRedemptions, type Money3 } from "@/modules/finance/queries";
import { brusselsDay } from "@/modules/finance/service/billit-sync";
import { periodError } from "@/modules/finance/service/exports";
import { bucketLabel } from "@/modules/finance/ui/dashboard/format";
import { financeLabels } from "@/modules/finance/ui/labels";
import { actionErrorText, fillLabel } from "@/modules/finance/ui/text";
import { PageHeader, SecondaryAction, Toolbar } from "@/modules/platform/ui/admin-kit";
import { BackLink, fieldClass, KpiStrip, Notice } from "@/modules/platform/ui/admin-list-kit";

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

/** A hairline surface with a compact title row and its export; the tables inside lose their own frame. */
function Section({ title, description, action, children }: { title: string; description: string; action: ReactNode; children: ReactNode }) {
  return (
    <section className="grid content-start gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="text-[0.9375rem] font-semibold">{title}</h2>
          <p className="max-w-3xl text-[0.75rem] text-muted-foreground">{description}</p>
        </div>
        {action}
      </div>
      <div className="grid gap-3 [&_[data-slot=table-container]]:rounded-none [&_[data-slot=table-container]]:border-0 [&_[data-slot=table-container]]:shadow-none">{children}</div>
    </section>
  );
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
 * Without `reports.finance` the page is a 404 (`requireStaff`). Out of the menu (owner review
 * November 2026): reached from Facturen ("More") and from Export boekhouder.
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
    <div className="grid gap-4">
      <BackLink href="/admin/finance/invoices">{translator(locale)("finance.nav.invoices")}</BackLink>
      <PageHeader title={l("title")} description={l("intro")} actions={<SecondaryAction href="/admin/finance/exports">{l("open_exports")}</SecondaryAction>} />

      <form data-auto-filter="" method="get" aria-label={l("filters")}>
        <Toolbar>
          {(
            [
              ["deferred-as-of", "asOf", l("as_of"), deferred.asOf],
              ["deferred-from", "from", l("from"), period.from],
              ["deferred-to", "to", l("to"), period.to],
            ] as const
          ).map(([id, name, label, value]) => (
            <label key={id} htmlFor={id} className="flex items-center gap-2 text-[0.8125rem]">
              <span className="text-muted-foreground">{label}</span>
              <input id={id} name={name} type="date" required defaultValue={value} className={cn(fieldClass, "w-40")} />
            </label>
          ))}
        </Toolbar>
      </form>
      <div aria-live="polite" role="status" className="grid gap-2 empty:hidden">
        {asOfFallback ? <Notice tone="bad">{l("as_of_invalid")}</Notice> : null}
        {periodInvalid ? <Notice tone="bad">{l("period_invalid")}</Notice> : null}
        {sp.requested === "1" ? (
          <Notice tone="ok" action={{ href: "/admin/finance/exports", label: l("open_exports") }}>
            {l("export_requested")}
          </Notice>
        ) : null}
        {errorText ? <Notice tone="bad">{errorText}</Notice> : null}
      </div>

      <Section
        title={l("deferred_title", { date: formatDate(deferred.asOf, locale) })}
        description={deferred.source === "today" ? l("deferred_today") : l("deferred_past", { date: formatDate(deferred.asOf, locale) })}
        action={<ExportButton kind="deferred_revenue" from={deferred.asOf} to={deferred.asOf} keep={keep} label={l("export_deferred_revenue")} />}
      >
          {!hasDeferred ? (
            <EmptyState title={l("empty")} />
          ) : (
            <>
              <KpiStrip items={(["grossCents", "netCents", "vatCents"] as const).map((k) => ({ key: k, label: l(k === "grossCents" ? "gross" : k === "netCents" ? "net" : "vat"), value: formatMoney(deferred.total[k], locale) }))} />
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
      </Section>

      <Section title={l("movements_title")} description={l("movements_intro")} action={<ExportButton kind="breakage" from={period.from} to={period.to} keep={keep} label={l("export_breakage")} />}>
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
      </Section>

      <Section title={l("vouchers_title")} description={l("vouchers_intro")} action={<ExportButton kind="voucher_redemptions" from={period.from} to={period.to} keep={keep} label={l("export_voucher_redemptions")} />}>
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
                      <TableCell>
                        <Link href={`/admin/orders/${r.orderId}`} className="font-medium hover:underline">
                          {l("open_order")}
                        </Link>
                      </TableCell>
                      <TableCell>{r.invoiceNumber ?? <span className="text-muted-foreground">{l("no_invoice")}</span>}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(r.amountCents, locale)}</TableCell>
                      <TableCell>{r.isReversed ? <Badge variant="secondary">{l("reversed")}</Badge> : l("common.none")}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
      </Section>

      <p className="text-[0.75rem] text-muted-foreground">{l("export_intro")}</p>
    </div>
  );
}

import { notFound } from "next/navigation";
import { ForbiddenError } from "@beam/core/errors";
import { formatMoney } from "@beam/core/i18n";
import { requireStaff } from "@/lib/auth";
import { createCtx, getAppDb, type Tx } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { getMyPartnerPerformance } from "@/modules/credits/queries";
import { PartnerFigures, type PartnerFigureRow } from "@/modules/credits/ui/partner-figures";
import { partnerScope } from "@/modules/platform/api";

/**
 * `/admin/partner` (credits spec section 5 and 7, R3; `partner.own`): the external partner's own
 * figures per month (referred, customers, revenue, commission accrued and paid) and their codes.
 * The company comes from platform's `partnerScope` (the partner user's person's
 * `partner_company_id`); aggregates only, never a customer name.
 */
export default async function PartnerPage() {
  const actor = await requireStaff({ permission: "partner.own" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const r = (k: string, p?: Record<string, string | number>) => tr(`credits.admin.partner.${k}`, p);
  const db = await getAppDb();
  let companyId: string;
  try {
    ({ companyId } = await partnerScope(createCtx({ tx: db as unknown as Tx, actor })));
  } catch (error) {
    if (error instanceof ForbiddenError) notFound();
    throw error;
  }
  const { months, codes } = await getMyPartnerPerformance(db, companyId);
  const money = (c: number) => formatMoney(c, locale);
  const monthLabel = (on: string) => new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${on}T00:00:00Z`));
  const rows: PartnerFigureRow[] = months.map((m) => ({
    key: m.periodMonth,
    label: monthLabel(m.periodMonth),
    referred: m.referredCount,
    customers: m.customersCount,
    revenueText: money(m.revenueCents),
    accruedText: money(m.commissionAccruedCents),
    paidText: money(m.commissionPaidCents),
  }));
  const sum = (f: (m: (typeof months)[number]) => number) => months.reduce((s, m) => s + f(m), 0);
  const totals = months.length
    ? {
        referred: sum((m) => m.referredCount),
        customers: sum((m) => m.customersCount),
        revenueText: money(sum((m) => m.revenueCents)),
        accruedText: money(sum((m) => m.commissionAccruedCents)),
        paidText: money(sum((m) => m.commissionPaidCents)),
      }
    : null;

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1 className="text-2xl font-semibold">{r("title")}</h1>
        <p className="max-w-prose text-muted-foreground">{r("intro")}</p>
      </header>
      <PartnerFigures
        rows={rows}
        totals={totals}
        labels={{
          caption: r("caption"),
          firstColumn: r("col_month"),
          referred: r("col_referred"),
          customers: r("col_customers"),
          revenue: r("col_revenue"),
          accrued: r("col_accrued"),
          paid: r("col_paid"),
          total: r("total"),
          empty: r("empty"),
        }}
      />
      <section aria-labelledby="partner-codes" className="grid gap-2">
        <h2 id="partner-codes" className="text-lg font-semibold">
          {r("codes_title")}
        </h2>
        {codes.length ? (
          <ul className="grid gap-1">
            {codes.map((c) => (
              <li key={c.code} className="flex flex-wrap items-center gap-3">
                <span className="font-mono">{c.code}</span>
                <span className="text-sm text-muted-foreground">{r("code_uses", { count: c.uses })}</span>
                {!c.isActive ? <span className="text-sm text-muted-foreground">{r("code_inactive")}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{r("codes_empty")}</p>
        )}
      </section>
    </div>
  );
}

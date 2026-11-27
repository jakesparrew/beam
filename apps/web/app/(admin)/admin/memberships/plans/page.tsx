import Link from "next/link";
import { EmptyState } from "@beam/ui";
import { hasPermission, requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { creditsLabels, listDiscountableProducts, listPlans } from "@/modules/credits/queries";
import { PlanBenefits, type BenefitRow } from "@/modules/credits/ui/plan-benefits";
import { PlanInclusions } from "@/modules/credits/ui/plan-inclusions";
import { PageHeader, Segmented, StatusPill } from "@/modules/platform/ui/admin-kit";
import { BackLink, Notice } from "@/modules/platform/ui/admin-list-kit";

/**
 * `/admin/memberships/plans` (`memberships.write`), credits spec section 5: membership products
 * (read from commerce) with primary and extra inclusions, discount, interval, active members and
 * the benefits list; a warning when a plan includes both day and night units. Back-office kit
 * (owner review, November 2026): one hairline surface per plan, its figures in one row.
 */
export default async function PlansPage() {
  const actor = await requireStaff({ permission: "memberships.write" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const p = (k: string, params?: Record<string, string | number>) => tr(`credits.admin.plans.${k}`, params);
  const db = await getAppDb();
  const plans = await listPlans(db);
  const scopeProducts = (await listDiscountableProducts(db)).map((o) => ({ productId: o.productId, name: o.name[locale] ?? o.sku }));
  const labels = creditsLabels(locale, ["admin.common", "admin.plans", "errors", "enum.kind", "enum.benefit_kind", "enum.discount_scope"]);
  return (
    <div className="grid gap-4">
      {hasPermission(actor, "credits.read") ? (
        <Segmented
          label={tr("credits.admin.area.label")}
          items={[
            { key: "credits", label: tr("credits.admin.grants.title"), href: "/admin/credits", active: false },
            { key: "memberships", label: tr("credits.admin.memberships.title"), href: "/admin/memberships", active: true },
          ]}
        />
      ) : null}
      <BackLink href="/admin/memberships">{tr("credits.admin.memberships.title")}</BackLink>
      <PageHeader title={p("title")} description={p("subtitle")} />
      {plans.length === 0 ? (
        <EmptyState
          title={p("empty")}
          action={
            <Link href="/admin/products" className="font-semibold hover:underline">
              {tr("commerce.nav.products")}
            </Link>
          }
        />
      ) : (
        plans.map((plan) => (
          <section key={plan.productId} aria-label={plan.name[locale] ?? plan.sku} className="overflow-hidden rounded-xl border border-border bg-card">
            <header className="flex flex-wrap items-center gap-2.5 border-b border-border px-5 py-3">
              <h2 className="text-[0.9375rem] font-semibold">{plan.name[locale] ?? plan.sku}</h2>
              {plan.isActive ? null : <StatusPill tone="muted">{p("inactive")}</StatusPill>}
              <span className="text-[0.8125rem] text-muted-foreground tabular-nums">{p("members", { count: plan.activeMembers })}</span>
            </header>
            <dl className="grid divide-y divide-border border-b border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <div className="grid gap-0.5 px-5 py-3">
                <dt className="text-[0.75rem] font-medium text-muted-foreground">{p("interval")}</dt>
                <dd className="text-[0.875rem] font-semibold">{plan.interval === "year" ? p("interval_year") : p("interval_month")}</dd>
              </div>
              <div className="grid gap-0.5 px-5 py-3">
                <dt className="text-[0.75rem] font-medium text-muted-foreground">{p("primary")}</dt>
                <dd className="text-[0.875rem] font-semibold">
                    {plan.includedCreditKind && plan.includedCreditUnits
                      ? p("primary_value", { units: plan.includedCreditUnits, kind: tr(`credits.enum.kind.${plan.includedCreditKind}`) })
                      : p("primary_none")}
                </dd>
              </div>
              <div className="grid gap-0.5 px-5 py-3">
                <dt className="text-[0.75rem] font-medium text-muted-foreground">{p("discount")}</dt>
                <dd className="text-[0.875rem] font-semibold tabular-nums">{p("discount_value", { pct: plan.memberDiscountPct })}</dd>
                <dd className="text-[0.75rem] text-muted-foreground">{p("discount_hint")}</dd>
              </div>
            </dl>
            <div className="grid gap-5 px-5 py-4">
              {plan.mixedVat ? (
                <Notice tone="warn" role="status">
                  {p("mixed_vat")}
                </Notice>
              ) : null}
              <section className="grid gap-2">
                <h3 className="text-[0.8125rem] font-semibold">{p("extra")}</h3>
                <PlanInclusions
                  productId={plan.productId}
                  primaryKind={plan.includedCreditKind}
                  inclusions={plan.inclusions
                    .filter((i) => i.creditKind !== "euro")
                    .map((i) => ({ kind: i.creditKind as "day" | "night", unitsPerPeriod: i.unitsPerPeriod, isActive: i.isActive, isAlternative: i.isAlternative }))}
                  labels={labels}
                />
              </section>
              <section className="grid gap-2">
                <h3 className="text-[0.8125rem] font-semibold">{p("benefits")}</h3>
                <PlanBenefits
                  productId={plan.productId}
                  locale={locale}
                  benefits={plan.benefits.map(
                    (b): BenefitRow => ({
                      id: b.id,
                      kind: b.kind,
                      text: b.text,
                      sortOrder: b.sortOrder,
                      isActive: b.isActive,
                      discountScope: b.discountScope,
                      discountPct: b.discountPct === null ? null : Number(b.discountPct),
                      scopeProductId: b.scopeProductId,
                    }),
                  )}
                  products={scopeProducts}
                  labels={labels}
                />
              </section>
            </div>
          </section>
        ))
      )}
    </div>
  );
}

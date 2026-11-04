import Link from "next/link";
import { Alert, AlertDescription, Badge, buttonVariants, Card, CardContent, CardHeader, CardTitle, EmptyState } from "@beam/ui";
import { requireStaff } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { adminLocale, translator } from "@/lib/i18n";
import { creditsLabels, listPlans } from "@/modules/credits/queries";
import { PlanBenefits, type BenefitRow } from "@/modules/credits/ui/plan-benefits";
import { PlanInclusions } from "@/modules/credits/ui/plan-inclusions";

/**
 * `/admin/memberships/plans` (`memberships.write`), credits spec section 5: membership products
 * (read from commerce) with primary and extra inclusions, discount, interval, active members and
 * the benefits list; a warning when a plan includes both day and night units.
 */
export default async function PlansPage() {
  await requireStaff({ permission: "memberships.write" });
  const locale = await adminLocale();
  const tr = translator(locale);
  const p = (k: string, params?: Record<string, string | number>) => tr(`credits.admin.plans.${k}`, params);
  const plans = await listPlans(await getAppDb());
  const labels = creditsLabels(locale, ["admin.common", "admin.plans", "errors", "enum.kind", "enum.benefit_kind"]);
  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <Link href="/admin/memberships" className="text-sm text-muted-foreground hover:underline">
          {p("back")}
        </Link>
        <h1 className="text-2xl font-semibold">{p("title")}</h1>
      </header>
      {plans.length === 0 ? (
        <EmptyState
          title={p("empty")}
          action={
            <Link href="/admin/products" className={buttonVariants({ variant: "outline" })}>
              {tr("commerce.nav.products")}
            </Link>
          }
        />
      ) : (
        plans.map((plan) => (
          <Card key={plan.productId}>
            <CardHeader className="flex flex-row flex-wrap items-center gap-3">
              <CardTitle>{plan.name[locale] ?? plan.sku}</CardTitle>
              {plan.isActive ? null : <Badge variant="outline">{p("inactive")}</Badge>}
              <span className="text-sm text-muted-foreground">{p("members", { count: plan.activeMembers })}</span>
            </CardHeader>
            <CardContent className="grid gap-5">
              {plan.mixedVat ? (
                <Alert role="status">
                  <AlertDescription>{p("mixed_vat")}</AlertDescription>
                </Alert>
              ) : null}
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
                <div>
                  <dt className="text-sm text-muted-foreground">{p("interval")}</dt>
                  <dd className="font-medium">{plan.interval === "year" ? p("interval_year") : p("interval_month")}</dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">{p("primary")}</dt>
                  <dd className="font-medium">
                    {plan.includedCreditKind && plan.includedCreditUnits
                      ? p("primary_value", { units: plan.includedCreditUnits, kind: tr(`credits.enum.kind.${plan.includedCreditKind}`) })
                      : p("primary_none")}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm text-muted-foreground">{p("discount")}</dt>
                  <dd className="font-medium">{p("discount_value", { pct: plan.memberDiscountPct })}</dd>
                </div>
              </dl>
              <section className="grid gap-2">
                <h2 className="text-base font-semibold">{p("extra")}</h2>
                <PlanInclusions
                  productId={plan.productId}
                  primaryKind={plan.includedCreditKind}
                  inclusions={plan.inclusions
                    .filter((i) => i.creditKind !== "euro")
                    .map((i) => ({ kind: i.creditKind as "day" | "night", unitsPerPeriod: i.unitsPerPeriod, isActive: i.isActive }))}
                  labels={labels}
                />
              </section>
              <section className="grid gap-2">
                <h2 className="text-base font-semibold">{p("benefits")}</h2>
                <PlanBenefits
                  productId={plan.productId}
                  locale={locale}
                  benefits={plan.benefits.map((b): BenefitRow => ({ id: b.id, kind: b.kind, text: b.text, sortOrder: b.sortOrder, isActive: b.isActive }))}
                  labels={labels}
                />
              </section>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

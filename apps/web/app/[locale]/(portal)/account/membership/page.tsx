import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmptyState } from "@beam/ui";
import { localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getMyMembership } from "@/modules/credits/queries";
import { MembershipCard, MembershipPeriods } from "@/modules/credits/ui/membership-card";
import { PlanBenefitsList } from "@/modules/credits/ui/plan-benefits-list";

/**
 * `/[locale]/account/membership` (credits spec section 5, rules 53 and 57): the customer's plan,
 * status, member since, current period, next renewal and amount, payment method, this period's
 * included sessions and nights, member discount, plan benefits and period history, with cancel
 * (the dialog states the end date), resume, pay now (past due or link renewal) and change plan.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (!locale) return {};
  return { title: translator(locale)("credits.portal.membership.title"), robots: { index: false, follow: false } };
}

function dateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export default async function AccountMembershipPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const m = await getMyMembership(await getAppDb(), actor.personId);
  const shop = `/${seg}/account/shop`;

  return (
    <section aria-labelledby="membership-title" className="grid max-w-3xl gap-6">
      <h1 id="membership-title" className="text-2xl font-semibold">
        {tr("credits.portal.membership.title")}
      </h1>
      {!m ? (
        <EmptyState
          title={tr("credits.portal.membership.empty")}
          action={
            <a href={shop} className="inline-flex min-h-11 items-center text-sm font-medium underline">
              {tr("credits.portal.membership.empty_link")}
            </a>
          }
        />
      ) : (
        <>
          <MembershipCard membership={m} locale={locale} shopHref={`${shop}?startsOn=${dateKey(m.cancelAt ?? m.currentPeriodEndAt)}`} />
          <PlanBenefitsList benefits={m.benefits} locale={locale} />
          <MembershipPeriods membership={m} locale={locale} />
          {m.status === "cancelled" || m.status === "expired" ? (
            <a href={shop} className="inline-flex min-h-11 w-fit items-center text-sm font-medium underline">
              {tr("credits.portal.membership.empty_link")}
            </a>
          ) : null}
        </>
      )}
    </section>
  );
}

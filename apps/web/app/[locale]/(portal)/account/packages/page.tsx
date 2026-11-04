import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EmptyState } from "@beam/ui";
import { formatDate, formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { redeemVoucher } from "@/modules/commerce/actions";
import { getMyPackages } from "@/modules/credits/queries";
import { grantTitle, PackageCard, unitsText } from "@/modules/credits/ui/package-card";
import { StoreCreditCard } from "@/modules/credits/ui/store-credit-card";

/**
 * `/[locale]/account/packages` (credits spec section 5, rules 36 and 37): the customer's usable
 * packages as cards with the remaining units in words and a progress bar, the store-credit card
 * with the "Redeem a gift voucher" field (commerce's `redeemVoucher`), packages that start later,
 * packages shared with them and, collapsed, the finished ones. Own data only.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (!locale) return {};
  return { title: translator(locale)("credits.portal.packages.title"), robots: { index: false, follow: false } };
}

export default async function AccountPackagesPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const data = await getMyPackages(await getAppDb(), actor.personId);
  const href = (grantId: string) => `/${seg}/account/packages/${grantId}`;
  const store = data.storeCredit;
  const nothing = data.active.length === 0 && data.upcoming.length === 0 && data.sharedWithMe.length === 0 && data.history.length === 0 && store.grants.length === 0;

  return (
    <section aria-labelledby="packages-title" className="grid max-w-4xl gap-6">
      <div className="grid gap-1">
        <h1 id="packages-title" className="text-2xl font-semibold">
          {tr("credits.portal.packages.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{tr("credits.portal.packages.intro")}</p>
      </div>
      <div className="flex flex-wrap gap-4">
        <a href={`/${seg}/account/book`} className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground">
          {tr("credits.portal.packages.book")}
        </a>
        <a href={`/${seg}/account/shop`} className="inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-medium">
          {tr("credits.portal.packages.buy")}
        </a>
      </div>

      {nothing ? (
        <EmptyState
          title={tr("credits.portal.packages.empty")}
          action={
            <a href={`/${seg}/account/shop`} className="inline-flex min-h-11 items-center text-sm font-medium underline">
              {tr("credits.portal.packages.empty_link")}
            </a>
          }
        />
      ) : null}

      {data.active.length > 0 ? (
        <section aria-labelledby="packages-active" className="grid gap-3">
          <h2 id="packages-active" className="text-lg font-semibold">
            {tr("credits.portal.packages.active")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {data.active.map((p) => (
              <PackageCard key={p.grantId} pkg={p} locale={locale} href={href(p.grantId)} />
            ))}
          </div>
        </section>
      ) : null}

      <StoreCreditCard
        amountText={store.remainingCents > 0 ? tr("credits.portal.packages.store_credit", { amount: formatMoney(store.remainingCents, locale) }) : tr("credits.portal.packages.store_credit_none")}
        expiryText={store.earliestExpiresAt ? tr("credits.portal.packages.earliest_expiry", { date: formatDate(store.earliestExpiresAt, locale) }) : null}
        redeem={redeemVoucher}
        labels={{
          title: tr("credits.portal.packages.store_credit_title"),
          redeemTitle: tr("credits.portal.packages.redeem_voucher"),
          code: tr("credits.portal.packages.redeem_code"),
          hint: tr("credits.portal.packages.redeem_hint"),
          submit: tr("credits.portal.packages.redeem_submit"),
          busy: tr("credits.portal.packages.redeem_busy"),
          done: tr("credits.portal.packages.redeem_done"),
          invalid: tr("credits.portal.packages.redeem_invalid"),
          generic: tr("credits.portal.errors.generic"),
          rateLimited: tr("credits.portal.errors.rate_limited"),
        }}
      />
      {store.grants.length > 0 ? (
        <ul className="grid gap-1 text-sm" aria-label={tr("credits.portal.packages.store_credit_title")}>
          {store.grants.map((g) => (
            <li key={g.grantId}>
              <a href={href(g.grantId)} className="inline-flex min-h-11 items-center underline">
                {grantTitle(g, locale, tr)}: {unitsText(g.kind, g.remainingUnits, locale, tr)}
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {data.upcoming.length > 0 ? (
        <section aria-labelledby="packages-upcoming" className="grid gap-3">
          <h2 id="packages-upcoming" className="text-lg font-semibold">
            {tr("credits.portal.packages.upcoming")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {data.upcoming.map((p) => (
              <PackageCard key={p.grantId} pkg={p} locale={locale} href={href(p.grantId)} upcoming />
            ))}
          </div>
        </section>
      ) : null}

      {data.sharedWithMe.length > 0 ? (
        <section aria-labelledby="packages-shared" className="grid gap-3">
          <h2 id="packages-shared" className="text-lg font-semibold">
            {tr("credits.portal.packages.shared_with_me")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {data.sharedWithMe.map((p) => (
              <PackageCard key={p.shareId} pkg={p} locale={locale} href={href(p.grantId)} sharedBy={p.ownerName} unitsForMe={p.unitsForMe} />
            ))}
          </div>
        </section>
      ) : null}

      {data.history.length > 0 ? (
        <details className="grid gap-3">
          <summary className="min-h-11 cursor-pointer py-2 text-lg font-semibold">{tr("credits.portal.packages.history_toggle", { count: data.history.length })}</summary>
          <div className="grid gap-4 pt-3 sm:grid-cols-2">
            {data.history.map((p) => (
              <PackageCard key={p.grantId} pkg={p} locale={locale} href={href(p.grantId)} closed />
            ))}
          </div>
        </details>
      ) : null}
    </section>
  );
}

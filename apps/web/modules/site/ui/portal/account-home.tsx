/**
 * The portal home `/[locale]/account` (site rule 47, section 5; site-P6): greeting with the first
 * name, open waitlist offers, the next five bookings, the balance per credit kind, the membership,
 * the install card and the quick actions. Every card renders from its own `Result`, so one
 * failing module shows "Temporarily unavailable" on its card only (rule 48).
 */
import type { Locale } from "@beam/core/i18n";
import type { AccountHome as AccountHomeData } from "../../queries/portal";
import { BalanceCard } from "./cards/balance-card";
import { BookingsCard, type Tr } from "./cards/bookings-card";
import { MembershipCard } from "./cards/membership-card";
import { OffersCard } from "./cards/offers-card";
import { QuickActions } from "./cards/quick-actions";
import { InstallPrompt, type InstallPromptLabels } from "./install-prompt";

export function installLabels(tr: Tr): InstallPromptLabels {
  return {
    title: tr("site.portal.install.title"),
    body: tr("site.portal.install.body"),
    button: tr("site.portal.install.button"),
    dismiss: tr("site.portal.install.dismiss"),
    ios: tr("site.portal.install.ios"),
  };
}

export function AccountHome({ locale, home, tr }: { locale: Locale; home: AccountHomeData; tr: Tr }) {
  return (
    <div className="grid gap-6" data-account-home>
      <h1 id="account-home-title" className="text-2xl font-semibold tracking-tight">
        {tr("site.portal.home.greeting", { firstName: home.firstName ?? "" }).trim()}
      </h1>
      <OffersCard locale={locale} offers={home.offers} tr={tr} />
      <div className="grid gap-6 md:grid-cols-2">
        <BookingsCard locale={locale} bookings={home.bookings} tr={tr} />
        <div className="grid content-start gap-6">
          <BalanceCard locale={locale} balances={home.balances} tr={tr} />
          <MembershipCard locale={locale} membership={home.membership} tr={tr} />
        </div>
      </div>
      <InstallPrompt labels={installLabels(tr)} />
      <QuickActions locale={locale} tr={tr} />
    </div>
  );
}

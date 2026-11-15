/**
 * The portal home `/[locale]/account` (site rule 47, section 5; site-P6): greeting with the first
 * name, open waitlist offers, the next five bookings, the balance per credit kind, the membership,
 * the install card and the quick actions. Every card renders from its own `Result`, so one
 * failing module shows "Temporarily unavailable" on its card only (rule 48). R2 (site-P8): the
 * upcoming-webinars card (behind `ff_webinar_portal`) and the "Shared with me" quick action.
 */
import type { Locale } from "@beam/core/i18n";
import { portalPath } from "@beam/core/site";
import type { AccountHome as AccountHomeData } from "../../queries/portal";
import { ArrowBadge, goldButtonClass } from "../public/block-renderer";
import { BalanceCard, remainingText } from "./cards/balance-card";
import { BookingsCard, type Tr } from "./cards/bookings-card";
import { MembershipCard } from "./cards/membership-card";
import { OffersCard } from "./cards/offers-card";
import { QuickActions } from "./cards/quick-actions";
import { WebinarsCard } from "./cards/webinars-card";
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

/**
 * The navy hero on top (one clear next step, as on a gym app's home): the greeting, then the next
 * visit with a link to it, or an invitation to book; the balance as pills on the side.
 */
function Hero({ locale, home, tr }: { locale: Locale; home: AccountHomeData; tr: Tr }) {
  const next = home.bookings.ok ? home.bookings.data[0] : undefined;
  const balances = home.balances.ok ? home.balances.data : [];
  const when = (d: Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", ...opts }).format(d);
  return (
    <section className="relative overflow-hidden rounded-[1.75rem] bg-[#212842] p-6 text-[#fffaef] sm:p-10" aria-labelledby="account-home-title">
      <div aria-hidden="true" className="pointer-events-none absolute -top-32 -right-24 size-96 rounded-full bg-[radial-gradient(circle,rgba(232,194,106,0.32),transparent_65%)]" />
      <div aria-hidden="true" className="absolute inset-0 bg-[radial-gradient(1px_1px_at_12%_20%,#fffaef,transparent),radial-gradient(1.5px_1.5px_at_32%_12%,#ffd76a,transparent),radial-gradient(1px_1px_at_70%_78%,#fffaef,transparent),radial-gradient(1px_1px_at_90%_30%,#fffaef,transparent)] opacity-60" />
      <div className="relative grid gap-8 md:grid-cols-[1fr_auto] md:items-end">
        <div className="grid gap-5">
          <h1 id="account-home-title" className="font-display text-4xl sm:text-5xl">
            {tr("site.portal.home.greeting", { firstName: home.firstName ?? "" }).trim()}
          </h1>
          {next ? (
            <div className="grid gap-3">
              <p className="text-xs font-semibold tracking-[0.25em] text-[#e8c26a] uppercase">{tr("site.portal.home.nextSession")}</p>
              <div className="flex flex-wrap items-center gap-4">
                <div className="grid min-w-16 place-items-center rounded-2xl bg-[#fffaef] px-3 py-2 text-[#212842]">
                  <span className="text-[0.65rem] font-semibold tracking-widest text-[#a0621e] uppercase">{when(next.startsAt, { month: "short" })}</span>
                  <span className="text-2xl leading-none font-semibold">{when(next.startsAt, { day: "numeric" })}</span>
                </div>
                <div>
                  <p className="text-xl font-semibold">{next.title[locale] ?? ""}</p>
                  <p className="text-[#fffaef]/75 first-letter:uppercase">
                    {when(next.startsAt, { weekday: "long" })} · {when(next.startsAt, { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-3 pt-1">
                <a href={`${portalPath(locale, "bookings")}/${next.bookingId}`} className="rounded-full bg-[#fffaef]/10 px-5 py-2.5 text-sm font-medium hover:bg-[#fffaef]/20">
                  {tr("site.portal.home.viewBooking")}
                </a>
                <a href={portalPath(locale, "book_day")} className={`${goldButtonClass} py-1.5 pr-1.5 pl-5 text-sm`}>
                  {tr("site.portal.home.bookAnother")}
                  <ArrowBadge dark />
                </a>
              </div>
            </div>
          ) : (
            <div className="grid max-w-xl gap-4">
              <p className="text-lg text-[#fffaef]/80">{tr("site.portal.home.readyBody")}</p>
              <a href={portalPath(locale, "book_day")} className={`${goldButtonClass} justify-self-start py-2 pr-2 pl-6`}>
                {tr("site.portal.home.bookNow")}
                <ArrowBadge dark />
              </a>
            </div>
          )}
        </div>
        {balances.length ? (
          <ul className="flex flex-wrap gap-2 md:max-w-xs md:flex-col md:items-end">
            {balances.map((b) => (
              <li key={b.kind} className="rounded-full bg-[#fffaef]/10 px-4 py-2 text-sm ring-1 ring-[#fffaef]/15">
                {remainingText(tr, locale, b)}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function AccountHome({ locale, home, tr }: { locale: Locale; home: AccountHomeData; tr: Tr }) {
  return (
    <div className="grid gap-6" data-account-home>
      <Hero locale={locale} home={home} tr={tr} />
      <OffersCard locale={locale} offers={home.offers} tr={tr} />
      <div className="grid gap-6 md:grid-cols-2">
        <BookingsCard locale={locale} bookings={home.bookings} tr={tr} />
        <div className="grid content-start gap-6">
          <BalanceCard locale={locale} balances={home.balances} tr={tr} />
          <MembershipCard locale={locale} membership={home.membership} tr={tr} />
          <WebinarsCard locale={locale} webinars={home.webinars} tr={tr} />
        </div>
      </div>
      <InstallPrompt labels={installLabels(tr)} />
      <QuickActions locale={locale} tr={tr} sharedWithMe={home.sharedWithMe} />
    </div>
  );
}

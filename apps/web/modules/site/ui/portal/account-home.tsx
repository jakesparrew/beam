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
import type { WellbeingJourney } from "@/modules/booking/api";
import { BalanceCard } from "./cards/balance-card";
import { CheckinCard, JourneyCard } from "./wellbeing";
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
 * The hero on top (one clear next step, as on a gym app's home): BEAM's space as a navy-tinted
 * photo (day or night, after the next visit), the greeting, then the next visit with a countdown
 * and two equal buttons, or an invitation to book.
 */
/** Whole days from now (per request: this is a server component). */
const daysUntil = (d: Date) => Math.max(0, Math.ceil((d.getTime() - Date.now()) / 86_400_000));

function Hero({ locale, home, tr }: { locale: Locale; home: AccountHomeData; tr: Tr }) {
  const next = home.bookings.ok ? home.bookings.data[0] : undefined;
  const when = (d: Date, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", ...opts }).format(d);
  const night = next ? /nacht|nuit|night/i.test(next.title[locale] ?? "") : false;
  const days = next ? daysUntil(next.startsAt) : 0;
  const button = "inline-flex h-12 items-center gap-3 rounded-full text-sm font-semibold";
  return (
    <section className="relative isolate overflow-hidden rounded-[2rem] p-6 text-[#fffaef] sm:p-10" aria-labelledby="account-home-title">
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand photo */}
      <img src={`/brand/book-${night ? "night" : "day"}.webp`} alt="" className="absolute inset-0 -z-20 h-full w-full object-cover" />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[linear-gradient(105deg,rgba(23,28,48,0.96)_0%,rgba(23,28,48,0.82)_50%,rgba(23,28,48,0.35)_100%)]" />
      <div className="grid max-w-2xl gap-6">
        <h1 id="account-home-title" className="font-display text-4xl sm:text-5xl">
          {tr("site.portal.home.greeting", { firstName: home.firstName ?? "" }).trim()}
        </h1>
        {next ? (
          <div className="grid gap-4">
            <p className="flex flex-wrap items-center gap-3 text-xs font-semibold tracking-[0.25em] text-[#e8c26a] uppercase">
              {tr("site.portal.home.nextSession")}
              <span className="rounded-full bg-[#fffaef]/12 px-3 py-1 tracking-normal text-[#fffaef] normal-case">{tr("site.portal.home.inDays", { count: days })}</span>
            </p>
            <div className="flex items-center gap-4">
              <div className="grid w-16 shrink-0 place-items-center rounded-2xl bg-[#fffaef] py-2 text-[#212842]">
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
            <div className="flex flex-wrap gap-3">
              <a href={`${portalPath(locale, "bookings")}/${next.bookingId}`} className={`${button} bg-[#fffaef]/12 px-6 ring-1 ring-[#fffaef]/20 hover:bg-[#fffaef]/20`}>
                {tr("site.portal.home.viewBooking")}
              </a>
              <a href={portalPath(locale, "book_day")} className={`${goldButtonClass} ${button} pr-1.5 pl-6`}>
                {tr("site.portal.home.bookAnother")}
                <ArrowBadge dark />
              </a>
            </div>
          </div>
        ) : (
          <div className="grid gap-4">
            <p className="text-lg text-[#fffaef]/80">{tr("site.portal.home.readyBody")}</p>
            <a href={portalPath(locale, "book_day")} className={`${goldButtonClass} ${button} justify-self-start pr-1.5 pl-6`}>
              {tr("site.portal.home.bookNow")}
              <ArrowBadge dark />
            </a>
          </div>
        )}
      </div>
    </section>
  );
}

/** Before the visit: what to bring and how to prepare (the same tips as the booking flow). */
function PrepareCard({ tr }: { tr: Tr }) {
  return (
    <section className="rounded-[1.5rem] bg-[#f4ead3] p-6" aria-labelledby="home-prepare-title">
      <h2 id="home-prepare-title" className="font-display text-2xl">
        {tr("site.bookFlow.bring.title")}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-[#212842]/80">{tr("site.bookFlow.bring.body")}</p>
      <h3 className="mt-4 font-semibold">{tr("site.bookFlow.after.title")}</h3>
      <p className="mt-1 text-sm leading-relaxed text-[#212842]/80">{tr("site.bookFlow.after.body")}</p>
    </section>
  );
}

export function AccountHome({
  locale,
  home,
  tr,
  wellbeing,
}: {
  locale: Locale;
  home: AccountHomeData;
  tr: Tr;
  /** The journey and check-in form (from booking); absent in tests and when booking fails. */
  wellbeing?: { journey: WellbeingJourney; action: (fd: FormData) => Promise<void>; saved: boolean } | null;
}) {
  return (
    <div className="grid gap-8" data-account-home>
      <Hero locale={locale} home={home} tr={tr} />
      <OffersCard locale={locale} offers={home.offers} tr={tr} />
      {wellbeing ? (
        <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
          <CheckinCard prompt={wellbeing.journey.prompt} action={wellbeing.action} saved={wellbeing.saved} locale={locale} tr={tr} />
          <JourneyCard journey={wellbeing.journey} tr={tr} />
        </div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <BookingsCard locale={locale} bookings={home.bookings} tr={tr} />
        </div>
        <div className="grid content-start gap-6">
          <BalanceCard locale={locale} balances={home.balances} tr={tr} />
          <MembershipCard locale={locale} membership={home.membership} tr={tr} />
          <WebinarsCard locale={locale} webinars={home.webinars} tr={tr} />
          <PrepareCard tr={tr} />
        </div>
      </div>
      <QuickActions locale={locale} tr={tr} sharedWithMe={home.sharedWithMe} />
      <InstallPrompt labels={installLabels(tr)} />
    </div>
  );
}

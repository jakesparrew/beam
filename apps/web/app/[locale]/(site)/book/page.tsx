import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatMoney, localeFromSegment, pick, URL_SEGMENT } from "@beam/core/i18n";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getBookingOffers } from "@/modules/booking/queries";
import { getAvailabilityPreviewForSite } from "@/modules/site/queries";
import { ArrowBadge, goldButtonClass } from "@/modules/site/ui/public/block-renderer";
import { buildWeeks } from "@/modules/site/ui/public/blocks/availability-preview";
import { AvailabilityWeeks } from "@/modules/site/ui/public/blocks/availability-week";
import { BookSteps, InfoCard, KindTips, TrustStrip } from "@/modules/site/ui/public/book-flow";

/**
 * `/[locale]/book`: the public booking flow, steps 1 and 2 (no login). Without `?kind=` the visitor
 * picks a day or night experience, explained; with it, a time in the next seven days and the
 * packages to buy instead, with their saving (owner's review 8). Each time leads to
 * `/[locale]/book/<sessionId>` (details without an account, then review and pay).
 * `/[locale]/account/book` sends visitors without a session here (proxy).
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  return locale ? { title: translator(locale)("site.bookFlow.metaTitle") } : {};
}

/** Owner's review 8: the sessions of the next seven days. */
const DAYS = 7;

export default async function PublicBookPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ kind?: string; tab?: string }> }) {
  const { locale: seg } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  const tr = translator(locale);
  const sp = await searchParams;
  const raw = sp.kind ?? sp.tab;
  const kind = raw === "day" || raw === "night" ? raw : null;
  const base = `/${URL_SEGMENT[locale]}/book`;

  if (!kind) {
    const card = (k: "day" | "night") => {
      const night = k === "night";
      return (
        <a
          href={`${base}?kind=${k}`}
          className="group relative isolate flex min-h-[30rem] flex-col justify-end overflow-hidden rounded-[2rem] p-7 text-[#fffaef] shadow-[0_24px_48px_-28px_rgb(33_40_66/0.6)]"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand photo */}
          <img src={`/brand/book-${k}.webp`} alt="" className="absolute inset-0 -z-20 h-full w-full object-cover transition duration-700 group-hover:scale-105" />
          <div
            aria-hidden="true"
            className={`absolute inset-0 -z-10 ${night ? "bg-[linear-gradient(180deg,rgba(23,28,48,0.35)_0%,rgba(23,28,48,0.92)_62%)]" : "bg-[linear-gradient(180deg,rgba(33,40,66,0.05)_0%,rgba(33,40,66,0.88)_62%)]"}`}
          />
          <span className="absolute top-6 left-6 rounded-full bg-[#fffaef]/90 px-3 py-1 text-xs font-semibold text-[#212842]">{tr(`site.bookFlow.${k}.tip`)}</span>
          <p className="text-xs font-semibold tracking-[0.25em] text-[#d1a64a] uppercase">{night ? "☾" : "☀"} {tr(`site.bookFlow.${k}.meta`)}</p>
          <h2 className="font-display mt-2 text-4xl">{tr(`site.bookFlow.${k}.title`)}</h2>
          <p className="mt-1 text-[#fffaef]/80">{tr(`site.bookFlow.${k}.times`)}</p>
          <ul className="mt-5 grid gap-2 text-sm text-[#fffaef]/90">
            {[1, 2, 3, 4].map((n) => (
              <li key={n} className="flex gap-2">
                <span aria-hidden="true" className="text-[#d1a64a]">
                  ✦
                </span>
                {tr(`site.bookFlow.${k}.b${n}`)}
              </li>
            ))}
          </ul>
          <span className={`${goldButtonClass} mt-6 self-start py-2 pr-2 pl-6`}>
            {tr("site.bookFlow.choose")}
            <ArrowBadge dark />
          </span>
        </a>
      );
    };
    return (
      <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
        <BookSteps current={1} tr={tr} />
        <header className="mb-8 max-w-2xl space-y-3">
          <h1 className="font-display text-4xl sm:text-5xl">{tr("site.bookFlow.s1.title")}</h1>
          <p className="text-lg leading-relaxed text-muted-foreground">{tr("site.bookFlow.s1.intro")}</p>
        </header>
        <div className="grid gap-6 md:grid-cols-2">
          {card("day")}
          {card("night")}
        </div>
        <div className="mt-8 grid gap-6 md:grid-cols-[2fr_1fr] md:items-center">
          <InfoCard title={tr("site.bookFlow.whatIs.title")} tone="sand">
            <p className="text-[#212842]/80">{tr("site.bookFlow.whatIs.body")}</p>
          </InfoCard>
          <TrustStrip tr={tr} />
        </div>
      </div>
    );
  }

  const slots = await getAvailabilityPreviewForSite(kind, DAYS).catch(() => []);
  const weeks = buildWeeks(slots, locale, tr, (id) => `${base}/${id}`);
  const night = kind === "night";
  // Owner's review 8: a package instead of a single session, with its saving (the prices of the first session shown).
  const firstSlot = slots[0];
  const { singleCents, offers } = firstSlot ? await getBookingOffers(await getAppDb(), firstSlot.sessionId).catch(() => ({ singleCents: null, offers: [] })) : { singleCents: null, offers: [] };
  const money = (cents: number) => formatMoney(cents, locale);
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <BookSteps current={2} tr={tr} />
      <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <header className="space-y-3">
            <a href={base} className="text-sm text-muted-foreground underline-offset-4 hover:underline">
              ← {tr("site.bookFlow.s2.change")}
            </a>
            <p className="text-xs font-semibold tracking-[0.25em] text-[#d1a64a] uppercase">
              {night ? "☾" : "☀"} {tr(`site.bookFlow.${kind}.title`)} · {tr(`site.bookFlow.${kind}.meta`)}
            </p>
            <h1 className="font-display text-4xl sm:text-5xl">{tr("site.bookFlow.s2.title")}</h1>
            <p className="text-muted-foreground">{tr("site.bookFlow.s2.intro")}</p>
          </header>
          <div className={`relative overflow-hidden rounded-[2rem] p-5 sm:p-8 ${night ? "site-on-dark bg-[#212842]" : "border border-border bg-card"}`}>
            {slots.length ? (
              <AvailabilityWeeks
                weeks={weeks}
                night={night}
                labels={{ prev: tr("site.blocks.availability.prevWeek"), next: tr("site.blocks.availability.nextWeek"), closed: tr("site.blocks.availability.closed") }}
              />
            ) : (
              <p className="text-muted-foreground">{tr("site.bookFlow.none")}</p>
            )}
          </div>
          <TrustStrip tr={tr} />
        </div>
        <aside className="space-y-4">
          {offers.length ? (
            <InfoCard title={tr("site.bookFlow.packages.title")} tone="sand">
              <p className="text-[#212842]/80">{tr("site.bookFlow.packages.body")}</p>
              <ul className="grid gap-3 pt-2" data-testid="package-offers">
                {offers.map((o) => (
                  <li key={o.productId} className="flex items-start justify-between gap-3 rounded-2xl bg-[#fffaef] p-3">
                    <span className="grid">
                      <span className="font-semibold text-[#212842]">{pick(o.name, locale)}</span>
                      <span className="text-[#212842]/75">
                        {tr("site.bookFlow.packages.per", { per: money(o.perSessionCents) })}
                        {o.savingPct !== null && singleCents !== null ? ` · ${tr("site.bookFlow.packages.save", { pct: o.savingPct, single: money(singleCents) })}` : ""}
                      </span>
                    </span>
                    <a
                      href={`/${URL_SEGMENT[locale]}/checkout?sku=${encodeURIComponent(o.sku)}&from=${encodeURIComponent(`${base}?kind=${kind}`)}`}
                      className="shrink-0 rounded-full bg-[#212842] px-4 py-2 text-xs font-semibold text-[#fffaef] hover:bg-[#2b3354]"
                      aria-label={tr("site.bookFlow.packages.buyNamed", { name: pick(o.name, locale), price: money(o.priceCents) })}
                    >
                      {money(o.priceCents)}
                    </a>
                  </li>
                ))}
              </ul>
              <p className="pt-1 text-xs text-[#212842]/70">{tr("site.bookFlow.packages.inFlow")}</p>
            </InfoCard>
          ) : null}
          <KindTips kind={kind} tr={tr} />
        </aside>
      </div>
    </div>
  );
}

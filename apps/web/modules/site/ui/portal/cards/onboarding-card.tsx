/**
 * Account home card "Complete your profile (2 of 4)" (owner requirements item 10): shown until
 * every onboarding step is answered or skipped, or the client hides it. "Continue" opens the
 * onboarding at its first open step; "Hide" posts the page's dismiss action (works without
 * JavaScript). Never blocks anything else on the home.
 */
import type { Tr } from "./bookings-card";
import { ArrowBadge, goldButtonClass } from "../../public/block-renderer";

export type OnboardingCardData = { answered: number; total: number; href: string; dismiss: (fd: FormData) => Promise<void> };

export function OnboardingCard({ data, tr }: { data: OnboardingCardData; tr: Tr }) {
  return (
    <section data-home-card="onboarding" aria-labelledby="home-onboarding-title" className="grid gap-4 rounded-[1.5rem] bg-[#f4ead3] p-6 sm:flex sm:items-center sm:justify-between">
      <div className="grid gap-2">
        <h2 id="home-onboarding-title" className="font-display text-2xl">
          {tr("site.portal.onboarding.title", { answered: data.answered, total: data.total })}
        </h2>
        <div
          role="progressbar"
          aria-labelledby="home-onboarding-title"
          aria-valuemin={0}
          aria-valuemax={data.total}
          aria-valuenow={data.answered}
          className="h-2 max-w-xs overflow-hidden rounded-full bg-[#212842]/10"
        >
          <div className="h-full rounded-full bg-[#d1a64a]" style={{ width: `${(data.answered / data.total) * 100}%` }} />
        </div>
        <p className="text-sm leading-relaxed text-[#212842]/80">{tr("site.portal.onboarding.body")}</p>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <a href={data.href} className={`${goldButtonClass} h-12 pr-1.5 pl-6`}>
          {tr("site.portal.onboarding.continue")}
          <ArrowBadge dark />
        </a>
        <form action={data.dismiss}>
          <button type="submit" className="h-12 rounded-full px-4 text-sm font-semibold text-[#212842]/70 hover:bg-[#212842]/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#212842]">
            {tr("site.portal.onboarding.dismiss")}
          </button>
        </form>
      </div>
    </section>
  );
}

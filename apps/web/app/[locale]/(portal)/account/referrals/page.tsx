import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatDate, localeFromSegment } from "@beam/core/i18n";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getMyReferrals } from "@/modules/credits/queries";
import { MyReferralCard } from "@/modules/credits/ui/my-referral-card";

/**
 * `/[locale]/account/referrals` (credits spec section 5, rule 60, R3; own data only): the
 * personal code and share link `…/<locale>?ref=<CODE>` (created on the first "Get my link"), the
 * number of friends who joined through it (a count, never names) and the rewards received.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  if (!locale) return {};
  return { title: translator(locale)("credits.portal.referrals.title"), robots: { index: false, follow: false } };
}

export default async function AccountReferralsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale: segment } = await params;
  const locale = localeFromSegment(segment);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const p = (k: string, v?: Record<string, string | number>) => tr(`credits.portal.referrals.${k}`, v);
  const mine = await getMyReferrals(await getAppDb(), actor.personId, locale);

  return (
    <section aria-labelledby="referrals-title" className="grid max-w-3xl gap-6">
      <header className="grid gap-2">
        <h1 id="referrals-title" className="text-2xl font-semibold">
          {p("title")}
        </h1>
        <p className="text-muted-foreground">{mine.code ? p("intro") : p("empty")}</p>
      </header>
      <MyReferralCard
        code={mine.code}
        shareUrl={mine.shareUrl}
        labels={{ codeLabel: p("code_label"), linkLabel: p("link_label"), getLink: p("get_link"), copy: p("copy"), copied: p("copied"), error: p("error") }}
      />
      <p>{p("referred_count", { count: mine.referredCount })}</p>
      <section aria-labelledby="referral-rewards" className="grid gap-2">
        <h2 id="referral-rewards" className="text-lg font-semibold">
          {p("rewards_title")}
        </h2>
        {mine.rewards.length ? (
          <ul className="grid gap-1">
            {mine.rewards.map((rw) => (
              <li key={rw.grantId}>
                {p("reward_line", {
                  date: formatDate(rw.grantedAt, locale),
                  what: tr(rw.creditKind === "night" ? "credits.portal.referrals.reward_nights" : "credits.portal.referrals.reward_sessions", { count: rw.units }),
                })}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">{p("rewards_empty")}</p>
        )}
      </section>
    </section>
  );
}

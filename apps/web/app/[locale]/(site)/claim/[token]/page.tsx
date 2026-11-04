import Link from "next/link";
import type { Metadata, Route } from "next";
import { notFound, redirect } from "next/navigation";
import { URL_SEGMENT, formatDateTime, localeFromSegment, type Locale, type LocalizedText } from "@beam/core/i18n";
import { buttonVariants } from "@beam/ui";
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { softTranslator, translator } from "@/lib/i18n";
import { claimSeat, declineOffer, requestClaimSignIn } from "@/modules/booking/actions";
import { getClaimOffer } from "@/modules/booking/queries";
import { OfferCountdown } from "@/modules/booking/ui/offer-countdown";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false }, referrer: "no-referrer" };

const show = (text: LocalizedText, locale: Locale) => text[locale] || text["nl-BE"] || text.en || text["fr-BE"] || "";

/**
 * `/[locale]/claim/[token]` (booking spec 5.3, R44): the seat offer behind a claim link. Opening
 * it never changes anything; "Confirm my seat" posts the `claimSeat` server action and "I can't
 * come" `declineOffer` with the token. A paid claim without the entry person's portal session
 * shows "Sign in to pay", which sends platform's magic link back to this page. States: live,
 * already claimed, expired or superseded, session cancelled or closed, invalid token. `noindex`,
 * `no-referrer` (the token is in the URL), no third-party scripts.
 */
export default async function ClaimPage({ params, searchParams }: { params: Promise<{ locale: string; token: string }>; searchParams: Promise<{ error?: string; sent?: string }> }) {
  const { locale: seg, token } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const sp = await searchParams;
  const offer = token === "invalid" ? null : await getClaimOffer(await getAppDb(), token);
  const here = `/${URL_SEGMENT[locale]}/claim/${encodeURIComponent(token)}`;
  const sessionHref = offer ? (`/${URL_SEGMENT[locale]}/account/book/${offer.sessionId}` as Route) : null;

  async function confirm() {
    "use server";
    const res = await claimSeat({ token });
    if (res.ok) redirect(res.data.redirectTo as Route);
    const reason = res.error.code === "conflict" || res.error.message === "sign_in_required" ? res.error.message : res.error.code;
    redirect(`${here}?error=${encodeURIComponent(reason)}` as Route);
  }
  async function decline() {
    "use server";
    const res = await declineOffer({ token });
    redirect((res.ok ? here : `${here}?error=${encodeURIComponent(res.error.message)}`) as Route);
  }
  async function signIn() {
    "use server";
    await requestClaimSignIn({ token });
    redirect(`${here}?sent=1` as Route);
  }

  if (!offer) {
    return (
      <section aria-labelledby="claim-title" className="mx-auto max-w-xl space-y-4 p-6">
        <h1 id="claim-title" className="text-2xl font-semibold">
          {tr("booking.claim.invalid")}
        </h1>
      </section>
    );
  }

  const actor = actorFromSession(await getSession());
  const signedInAsPerson = actor?.kind === "customer" && actor.personId === offer.personId;
  const needsSignIn = offer.payment === "order" && !signedInAsPerson;
  const errorKey = `booking.errors.${sp.error ?? ""}`;
  const errorText = sp.error === "sign_in_required" ? tr("booking.claim.sign_in_to_pay") : sp.error ? (soft(errorKey) !== errorKey ? soft(errorKey) : tr("booking.claim.expired")) : null;

  return (
    <section aria-labelledby="claim-title" className="mx-auto max-w-xl space-y-4 p-6" data-testid={`claim-${offer.state}`}>
      <h1 id="claim-title" className="text-2xl font-semibold">
        {tr("booking.claim.title")}
      </h1>
      {offer.firstName ? <p>{tr("booking.claim.greeting", { firstName: offer.firstName })}</p> : null}
      <p>{tr("booking.claim.session", { title: show(offer.title, locale), date: formatDateTime(offer.startsAt, locale, "full") })}</p>
      {errorText ? (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm">
          {errorText}
        </p>
      ) : null}
      {sp.sent ? (
        <p role="status" className="rounded-md border p-3 text-sm">
          {tr("booking.claim.sign_in_sent")}
        </p>
      ) : null}

      {offer.state === "live" && offer.offerExpiresAt ? (
        <>
          <OfferCountdown
            expiresAt={offer.offerExpiresAt.toISOString()}
            locale={locale}
            labels={{ label: tr("booking.claim.expires", { time: "{time}" }), expired: tr("booking.claim.expired") }}
          />
          <p className="text-sm text-muted-foreground">{offer.payment === "credit" ? tr("booking.claim.credit_hint") : offer.payment === "order" ? tr("booking.claim.pay_hint") : null}</p>
          <div className="flex flex-wrap gap-2">
            {needsSignIn ? (
              <form action={signIn}>
                <button type="submit" className={buttonVariants({})} data-testid="claim-sign-in">
                  {tr("booking.claim.sign_in_to_pay")}
                </button>
              </form>
            ) : (
              <form action={confirm}>
                <button type="submit" className={buttonVariants({})} data-testid="claim-confirm">
                  {tr("booking.claim.confirm")}
                </button>
              </form>
            )}
            <form action={decline}>
              <button type="submit" className={buttonVariants({ variant: "outline" })} data-testid="claim-decline">
                {tr("booking.claim.decline")}
              </button>
            </form>
          </div>
        </>
      ) : null}

      {offer.state === "claimed" ? (
        <div className="space-y-2">
          <p>{tr("booking.claim.already_claimed")}</p>
          {offer.bookingId ? (
            <Link href={`/${URL_SEGMENT[locale]}/account/bookings/${offer.bookingId}` as Route} className={buttonVariants({ variant: "outline" })}>
              {tr("booking.claim.view_booking")}
            </Link>
          ) : null}
        </div>
      ) : null}
      {offer.state === "expired" ? <p data-testid="claim-expired-text">{tr("booking.claim.expired")}</p> : null}
      {offer.state === "session_cancelled" ? <p>{tr("booking.claim.session_cancelled")}</p> : null}
      {offer.state === "session_closed" ? <p>{tr("booking.claim.session_closed")}</p> : null}
      {offer.state !== "live" && offer.state !== "claimed" && sessionHref ? (
        <Link href={sessionHref} className={buttonVariants({ variant: "outline" })}>
          {tr("booking.claim.view_session")}
        </Link>
      ) : null}
    </section>
  );
}

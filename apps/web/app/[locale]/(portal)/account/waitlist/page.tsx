import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { URL_SEGMENT, formatDateTime, localeFromSegment, type Locale, type LocalizedText } from "@beam/core/i18n";
import { buttonVariants } from "@beam/ui";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { softTranslator, translator } from "@/lib/i18n";
import { declineOffer, joinWaitlist, withdrawFromWaitlist } from "@/modules/booking/actions";
import { listMyWaitlist } from "@/modules/booking/queries";
import { OfferCountdown } from "@/modules/booking/ui/offer-countdown";

const show = (text: LocalizedText, locale: Locale) => text[locale] || text["nl-BE"] || text.en || text["fr-BE"] || "";

/**
 * `/[locale]/account/waitlist` (booking spec 5.2, R27, R40, R46): the customer's entries of
 * sessions that have not started: waiting (queue name, position only when the session shows it),
 * offered (countdown and "Claim my seat", which opens the claim page), confirmed (link to the
 * booking), expired or released (rejoin once). Buttons are plain forms posting server actions,
 * so the page works without client JavaScript.
 */
export default async function MyWaitlistPage({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ error?: string }> }) {
  const { locale: seg } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const { error } = await searchParams;
  const rows = await listMyWaitlist(await getAppDb(), actor.personId);
  const here = `/${URL_SEGMENT[locale]}/account/waitlist`;

  async function act(formData: FormData) {
    "use server";
    const field = (k: string) => { const v = formData.get(k); return typeof v === "string" ? v : ""; };
    const op = field("op");
    const id = field("id");
    const res =
      op === "withdraw"
        ? await withdrawFromWaitlist({ entryId: id })
        : op === "decline"
          ? await declineOffer({ entryId: id })
          : await joinWaitlist({ sessionId: id, acceptTerms: formData.get("acceptTerms") === "on" });
    const reason = res.ok ? null : res.error.code === "conflict" ? res.error.message : res.error.code;
    redirect((reason ? `${here}?error=${encodeURIComponent(reason)}` : here) as Route);
  }

  const soft = softTranslator(locale);
  const errorKey = `booking.errors.${error ?? ""}`;
  const errorText = error ? (soft(errorKey) !== errorKey ? soft(errorKey) : tr("booking.errors.invalid_transition")) : null;
  return (
    <section aria-labelledby="my-waitlist-title" className="space-y-4">
      <h1 id="my-waitlist-title" className="text-2xl font-semibold">
        {tr("booking.portalWaitlist.title")}
      </h1>
      {errorText ? (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm">
          {errorText}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <div className="space-y-2">
          <p>{tr("booking.portalWaitlist.empty")}</p>
          <Link href={`/${URL_SEGMENT[locale]}/account/book` as Route} className={buttonVariants({ variant: "outline" })}>
            {tr("booking.portalSession.join_waitlist")}
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.entryId} className="rounded-lg border p-4" data-testid={`my-waitlist-${r.entryId}`}>
              <h2 className="font-medium">{show(r.title, locale)}</h2>
              <p className="text-sm text-muted-foreground">{formatDateTime(r.startsAt, locale, "full")}</p>
              <p className="text-sm">
                {tr(`booking.waitlistState.${r.state}`)} · {tr(`booking.queue.${r.queue}`)}
                {r.position ? ` · ${tr("booking.portalWaitlist.position", { position: r.position })}` : ""}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {r.state === "offered" && r.offerExpiresAt && r.claimToken && !r.bookingId ? (
                  <>
                    <OfferCountdown
                      expiresAt={r.offerExpiresAt.toISOString()}
                      locale={locale}
                      labels={{ label: tr("booking.portalWaitlist.offer_countdown", { time: "{time}" }), expired: tr("booking.claim.expired") }}
                    />
                    <Link href={`/${URL_SEGMENT[locale]}/claim/${r.claimToken}` as Route} className={buttonVariants({})}>
                      {tr("booking.portalWaitlist.claim")}
                    </Link>
                    <form action={act}>
                      <input type="hidden" name="op" value="decline" />
                      <input type="hidden" name="id" value={r.entryId} />
                      <button type="submit" className={buttonVariants({ variant: "outline" })}>
                        {tr("booking.portalWaitlist.decline")}
                      </button>
                    </form>
                  </>
                ) : null}
                {r.state === "offered" && r.bookingId && r.claimToken ? (
                  <Link href={`/${URL_SEGMENT[locale]}/claim/${r.claimToken}` as Route} className={buttonVariants({})}>
                    {tr("booking.claim.already_claimed")}
                  </Link>
                ) : null}
                {r.state === "waiting" ? (
                  <form action={act}>
                    <input type="hidden" name="op" value="withdraw" />
                    <input type="hidden" name="id" value={r.entryId} />
                    <button type="submit" className={buttonVariants({ variant: "outline" })}>
                      {tr("booking.portalWaitlist.withdraw")}
                    </button>
                  </form>
                ) : null}
                {r.state === "confirmed" && r.bookingId ? (
                  <Link href={`/${URL_SEGMENT[locale]}/account/bookings/${r.bookingId}` as Route} className={buttonVariants({ variant: "outline" })}>
                    {tr("booking.portalWaitlist.view_booking")}
                  </Link>
                ) : null}
                {r.canRejoin ? (
                  <form action={act}>
                    <input type="hidden" name="op" value="rejoin" />
                    <input type="hidden" name="id" value={r.sessionId} />
                    <button type="submit" className={buttonVariants({ variant: "outline" })}>
                      {tr("booking.portalWaitlist.rejoin")}
                    </button>
                  </form>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

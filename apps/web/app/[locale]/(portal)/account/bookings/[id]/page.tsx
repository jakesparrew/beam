import { randomUUID } from "node:crypto";
import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { bookings, orderLines } from "@beam/db/schema";
import { freeCancelUntil } from "@beam/core/booking";
import { URL_SEGMENT, formatDateTime, formatTime, localeFromSegment, pick } from "@beam/core/i18n";
import { Badge, buttonVariants, cn } from "@beam/ui";
import { requireCustomer } from "@/lib/auth";
import { NotFoundError, eq, getAppDb } from "@/lib/ctx";
import { softTranslator, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { addMyGuest, cancelMyBooking } from "@/modules/booking/actions";
import { getMyBooking } from "@/modules/booking/queries";
import { GuestFields } from "@/modules/booking/ui/portal/guest-fields";
import { PolicyNote } from "@/modules/booking/ui/portal/policy-note";
import { QrCard } from "@/modules/booking/ui/portal/qr-card";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DONE = { booked: "booked_ok", cancelled: "cancelled_ok", rescheduled: "rescheduled_ok", guest: "guest_added" } as const;

const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/**
 * `/[locale]/account/bookings/[id]` (booking spec 5.2, R28-R31, R54-R56): the QR code for
 * reception, the session, guests, payment and the policy ("Free cancellation until ..." or
 * "Cancelling now keeps the session used"); cancel behind a confirmation that states the
 * outcome, reschedule, invite a guest and "Add to calendar". A cancelled booking is read-only;
 * a reserved one shows "Awaiting payment until {time}" with "Complete payment" and no cancel;
 * a pay-at-desk one shows "Pay at reception".
 */
export default async function MyBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const { locale: seg, id } = await params;
  const locale = localeFromSegment(seg);
  if (!locale || !UUID.test(id)) notFound();
  const actor = await requireCustomer(locale);
  const me = actor.personId;
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const { error, done } = await searchParams;
  const db = await getAppDb();
  const b = await getMyBooking(db, me, id).catch((e: unknown) => {
    if (e instanceof NotFoundError) return null;
    throw e;
  });
  if (!b) notFound();
  const rules = await getSetting(db, "booking_rules");
  const now = new Date();
  const here = `/${URL_SEGMENT[locale]}/account/bookings/${id}`;

  const [line] =
    b.status === "reserved"
      ? await db.select({ orderId: orderLines.orderId }).from(bookings).innerJoin(orderLines, eq(orderLines.id, bookings.orderLineId)).where(eq(bookings.id, id))
      : [];

  async function cancel(formData: FormData) {
    "use server";
    const res = await cancelMyBooking({ bookingId: id, expectedVersion: Number(str(formData, "version") ?? 0), includeGuests: formData.get("includeGuests") === "on" });
    if (!res.ok) {
      const reason = res.error.code === "conflict" ? res.error.message : res.error.code;
      redirect(`${here}?error=${encodeURIComponent(reason)}` as Route);
    }
    redirect(`${here}?done=cancelled` as Route);
  }

  async function invite(formData: FormData) {
    "use server";
    const firstName = str(formData, "guests.0.firstName") ?? "";
    const lastName = str(formData, "guests.0.lastName") ?? "";
    const email = str(formData, "guests.0.email");
    const res = await addMyGuest({
      ownerBookingId: id,
      clientKey: str(formData, "clientKey") ?? randomUUID(),
      guest: {
        firstName,
        lastName,
        ...(email ? { email } : {}),
        ...(formData.get("guests.0.sharesBed") === "on" ? { sharesBed: true } : {}),
        payWith: str(formData, "guests.0.payWith") === "order" ? "order" : "guest",
      },
    });
    if (!res.ok) {
      const reason = res.error.code === "conflict" ? res.error.message : res.error.code;
      redirect(`${here}?error=${encodeURIComponent(reason)}` as Route);
    }
    if ("kind" in res.data) redirect(res.data.redirectTo as Route);
    redirect(`${here}?done=guest` as Route);
  }

  const errorText = error ? (soft(`booking.errors.${error}`) !== `booking.errors.${error}` ? soft(`booking.errors.${error}`) : tr("booking.errors.generic")) : null;
  const doneText = done && done in DONE ? tr(`booking.portalBooking.${DONE[done as keyof typeof DONE]}`) : null;

  const started = b.startsAt.getTime() <= now.getTime();
  const confirmed = b.status === "confirmed";
  const isOwnerRow = b.personId === me && !b.isGuest;
  const iBookedThisGuest = b.personId !== me;
  const freeUntil = freeCancelUntil(b.kind, b.startsAt, rules);
  const inFree = !!freeUntil && now.getTime() < freeUntil.getTime();
  const canCancel = confirmed && !started && b.sessionStatus !== "cancelled";
  const canReschedule = canCancel && inFree && (isOwnerRow || iBookedThisGuest);
  const liveGuests = b.guests.filter((g) => g.status === "confirmed" || g.status === "reserved");
  const canInvite = canCancel && isOwnerRow && rules.max_guests_per_booking > liveGuests.length && b.kind !== "event";
  const outcome = !inFree
    ? tr("booking.portalBooking.cancel_confirm_late")
    : b.paidWith === "order"
      ? tr("booking.portalBooking.cancel_confirm_refund")
      : tr("booking.portalBooking.cancel_confirm_free");
  const policy = inFree ? tr("booking.portalBooking.policy_free", { date: formatDateTime(freeUntil, locale, "full") }) : tr("booking.portalBooking.policy_late");
  const title = pick(b.title, locale);

  return (
    <section aria-labelledby="booking-title" className="space-y-5">
      <Link href={`/${URL_SEGMENT[locale]}/account/bookings` as Route} className="text-sm underline">
        {tr("booking.portalBooking.back")}
      </Link>
      <h1 id="booking-title" className="text-2xl font-semibold">
        {title}
      </h1>
      {doneText ? (
        <p role="status" className="rounded-md border border-success bg-success/10 p-3" data-testid="booking-done">
          {doneText}
        </p>
      ) : null}
      {errorText ? (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm" data-testid="booking-error">
          {errorText}
        </p>
      ) : null}

      <div className="grid gap-5 md:grid-cols-[1fr_auto]">
        <dl className="grid gap-3 sm:grid-cols-[auto_1fr] sm:gap-x-6">
          <dt className="font-medium">{tr("booking.portalBooking.when")}</dt>
          <dd>
            {formatDateTime(b.startsAt, locale, "full")} – {formatTime(b.endsAt, locale)}
          </dd>
          {b.location ? (
            <>
              <dt className="font-medium">{tr("booking.portalBooking.where")}</dt>
              <dd>{b.location}</dd>
            </>
          ) : null}
          <dt className="font-medium">{tr("booking.portalBooking.status")}</dt>
          <dd>
            <Badge variant={confirmed || b.status === "attended" ? "success" : b.status === "reserved" ? "warning" : "outline"} data-testid="booking-status">
              {tr(`booking.status.${b.status}`)}
            </Badge>
          </dd>
          <dt className="font-medium">{tr("booking.portalBooking.payment")}</dt>
          <dd>{b.isPayAtDesk ? tr("booking.portalBooking.pay_at_reception") : tr(`booking.paidWith.${b.paidWith}`)}</dd>
          <dt className="font-medium">{tr("booking.portalBooking.guests")}</dt>
          <dd>
            {b.guests.length === 0 ? (
              <span className="text-muted-foreground">{tr("booking.portalBooking.no_guests")}</span>
            ) : (
              <ul data-testid="booking-guests">
                {b.guests.map((g) => (
                  <li key={g.id}>
                    {[g.firstName, g.lastName].filter(Boolean).join(" ")} · {tr(`booking.status.${g.status}`)}
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </dl>
        <QrCard
          qrSvg={b.qrSvg}
          event={b.status === "cancelled" || b.status === "late_cancelled" ? null : { uid: b.id, title, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString(), location: b.location }}
          labels={{ qrLabel: tr("booking.portalBooking.qr_label"), hint: tr("booking.portalBooking.qr_hint"), addToCalendar: tr("booking.portalBooking.add_to_calendar") }}
        />
      </div>

      {b.status === "cancelled" || b.status === "late_cancelled" ? (
        <p className="rounded-md border p-3" data-testid="booking-cancelled">
          {tr("booking.portalBooking.cancelled")}
          {b.cancelReasonCode ? ` ${tr(`booking.cancelReason.${b.cancelReasonCode}`)}.` : ""}
        </p>
      ) : null}

      {b.status === "reserved" && b.reservedUntil ? (
        <div className="space-y-2 rounded-md border border-warning bg-warning/10 p-3" data-testid="booking-reserved">
          <p>{b.isPayAtDesk ? tr("booking.portalBooking.pay_at_reception") : tr("booking.portalBooking.awaiting_payment", { time: formatDateTime(b.reservedUntil, locale, "full") })}</p>
          {line && !b.isPayAtDesk ? (
            <Link href={`/${URL_SEGMENT[locale]}/account/checkout/${line.orderId}` as Route} className={cn(buttonVariants({}), "min-h-11")}>
              {tr("booking.portalBooking.complete_payment")}
            </Link>
          ) : null}
        </div>
      ) : null}

      {canCancel ? <PolicyNote policy={policy} tone={inFree ? "info" : "warning"} /> : null}

      <div className="flex flex-wrap gap-3">
        {canReschedule ? (
          <Link href={`${here}/reschedule` as Route} className={cn(buttonVariants({ variant: "outline" }), "min-h-11")} data-testid="reschedule-link">
            {tr("booking.portalBooking.reschedule")}
          </Link>
        ) : null}
      </div>

      {canCancel ? (
        <details className="rounded-md border p-3" data-testid="cancel-booking">
          <summary className="flex min-h-11 cursor-pointer items-center font-medium">{tr("booking.portalBooking.cancel")}</summary>
          <form action={cancel} className="mt-3 space-y-3">
            <input type="hidden" name="version" value={b.version} />
            <p className="font-medium">{tr("booking.portalBooking.cancel_question")}</p>
            <p data-testid="cancel-outcome">{outcome}</p>
            {isOwnerRow && liveGuests.length > 0 ? (
              <label className="flex min-h-11 items-center gap-3">
                <input type="checkbox" name="includeGuests" defaultChecked className="size-5" />
                <span>{tr("booking.portalBooking.include_guests")}</span>
              </label>
            ) : null}
            <button type="submit" className={cn(buttonVariants({ variant: "destructive" }), "min-h-11")} data-testid="cancel-confirm">
              {tr("booking.portalBooking.cancel")}
            </button>
          </form>
        </details>
      ) : null}

      {canInvite ? (
        <details className="rounded-md border p-3" data-testid="invite-guest">
          <summary className="flex min-h-11 cursor-pointer items-center font-medium">{tr("booking.portalBooking.invite_guest")}</summary>
          <form action={invite} className="mt-3 space-y-3">
            <input type="hidden" name="clientKey" value={randomUUID()} />
            <GuestFields
              initial={1}
              fixed
              max={1}
              isNight={b.kind === "night"}
              payOptions={b.paidWith === "credit" ? ["guest", "order"] : ["order"]}
              labels={{
                legend: tr("booking.portalBooking.invite_guest"),
                guestNumber: tr("booking.portalSession.guest_number", { n: "{n}" }),
                firstName: tr("booking.portalSession.guest_first_name"),
                lastName: tr("booking.portalSession.guest_last_name"),
                email: tr("booking.portalSession.guest_email"),
                sharesBed: tr("booking.portalSession.guest_shares_bed"),
                payLabel: tr("booking.portalSession.guest_pay_label"),
                payGuest: tr("booking.portalSession.guest_pay_guest"),
                payOrder: tr("booking.portalSession.guest_pay_order"),
                add: tr("booking.portalSession.add_guest"),
                remove: tr("booking.portalSession.remove_guest"),
              }}
            />
            <button type="submit" className={cn(buttonVariants({}), "min-h-11")} data-testid="invite-submit">
              {tr("booking.portalBooking.invite_submit")}
            </button>
          </form>
        </details>
      ) : null}
    </section>
  );
}

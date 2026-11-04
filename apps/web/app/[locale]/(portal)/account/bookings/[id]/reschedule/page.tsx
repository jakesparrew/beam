import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { describeAvailability } from "@beam/core/booking";
import { URL_SEGMENT, formatDateTime, formatTime, localeFromSegment, pick } from "@beam/core/i18n";
import { buttonVariants, cn } from "@beam/ui";
import { requireCustomer } from "@/lib/auth";
import { NotFoundError, getAppDb } from "@/lib/ctx";
import { softTranslator, translator } from "@/lib/i18n";
import { rescheduleMyBooking } from "@/modules/booking/actions";
import { getMyBooking, listRescheduleTargets } from "@/modules/booking/queries";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `/[locale]/account/bookings/[id]/reschedule` (booking spec 5.2, R31): the sessions this
 * booking may move to (same kind, credit kind and, for orders, product; inside the free window;
 * chain limit), as one radio group with a confirm button. The move keeps the payment and lands
 * on the new booking. Empty: "No other session available in your free window".
 */
export default async function ReschedulePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale: seg, id } = await params;
  const locale = localeFromSegment(seg);
  if (!locale || !UUID.test(id)) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const { error } = await searchParams;
  const db = await getAppDb();
  const b = await getMyBooking(db, actor.personId, id).catch((e: unknown) => {
    if (e instanceof NotFoundError) return null;
    throw e;
  });
  if (!b) notFound();
  const targets = await listRescheduleTargets(db, actor.personId, id);
  const back = `/${URL_SEGMENT[locale]}/account/bookings/${id}`;

  async function move(formData: FormData) {
    "use server";
    const target = formData.get("targetSessionId");
    const res = await rescheduleMyBooking({ bookingId: id, expectedVersion: b!.version, targetSessionId: typeof target === "string" ? target : "" });
    if (!res.ok) {
      const reason = res.error.code === "conflict" ? res.error.message : res.error.code;
      redirect(`${back}/reschedule?error=${encodeURIComponent(reason)}` as Route);
    }
    redirect(`/${URL_SEGMENT[locale!]}/account/bookings/${res.data.newBookingId}?done=rescheduled` as Route);
  }

  const errorText = error ? (soft(`booking.errors.${error}`) !== `booking.errors.${error}` ? soft(`booking.errors.${error}`) : tr("booking.errors.generic")) : null;

  return (
    <section aria-labelledby="reschedule-title" className="space-y-5">
      <Link href={back as Route} className="text-sm underline">
        {tr("booking.portalReschedule.back")}
      </Link>
      <h1 id="reschedule-title" className="text-2xl font-semibold">
        {tr("booking.portalReschedule.title")}
      </h1>
      <p>{tr("booking.portalReschedule.current", { date: `${pick(b.title, locale)}, ${formatDateTime(b.startsAt, locale, "full")}` })}</p>
      {errorText ? (
        <p role="alert" id="reschedule-error" className="rounded-md border border-destructive p-3 text-sm">
          {errorText}
        </p>
      ) : null}
      {targets.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-dashed p-6 text-center" data-testid="reschedule-empty">
          <p>{tr("booking.portalReschedule.empty")}</p>
          <Link href={back as Route} className={cn(buttonVariants({ variant: "outline" }), "min-h-11")}>
            {tr("booking.portalReschedule.back")}
          </Link>
        </div>
      ) : (
        <form action={move} className="space-y-4">
          <fieldset className="space-y-2" aria-describedby={errorText ? "reschedule-error" : undefined}>
            <legend className="font-medium">{tr("booking.portalReschedule.pick")}</legend>
            {targets.map((t, i) => {
              const d = describeAvailability(t.availability, locale);
              const availability = tr(d.labelKey, d.params.count ? { ...d.params, count: Number(d.params.count) } : d.params);
              return (
                <label key={t.sessionId} className="flex min-h-11 items-start gap-3 rounded-md border p-3" data-testid={`target-${t.sessionId}`}>
                  <input type="radio" name="targetSessionId" value={t.sessionId} defaultChecked={i === 0} required className="mt-1 size-5" />
                  <span className="flex flex-col">
                    <span className="font-medium">
                      {formatDateTime(t.startsAt, locale, "full")} – {formatTime(t.endsAt, locale)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {pick(t.title, locale)} · {availability}
                    </span>
                  </span>
                </label>
              );
            })}
          </fieldset>
          <button type="submit" className={cn(buttonVariants({}), "min-h-11")} data-testid="reschedule-confirm">
            {tr("booking.portalReschedule.confirm")}
          </button>
        </form>
      )}
    </section>
  );
}

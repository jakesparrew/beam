import { randomUUID } from "node:crypto";
import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { freeCancelUntil } from "@beam/core/booking";
import { URL_SEGMENT, formatDateTime, formatMoney, formatTime, localeFromSegment, pick } from "@beam/core/i18n";
import { buttonVariants } from "@beam/ui";
import { requireCustomer } from "@/lib/auth";
import { NotFoundError, getAppDb } from "@/lib/ctx";
import { softTranslator, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { getQuote } from "@/modules/commerce/api";
import { getPersonCreditSummary } from "@/modules/credits/api";
import { getCurrentLegalVersion, getLegalLinks, hasAcceptedCurrentTerms } from "@/modules/site/api";
import { bookSession, joinWaitlist } from "@/modules/booking/actions";
import { getBookableSession } from "@/modules/booking/queries";
import { BookForm, type PayOption, type TicketTypeOption } from "@/modules/booking/ui/portal/book-form";
import { PolicyNote } from "@/modules/booking/ui/portal/policy-note";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELD_OF: Record<string, "terms" | "emergency" | "payment" | "ticket"> = {
  terms_required: "terms",
  emergency_contact_required: "emergency",
  insufficient_credits: "payment",
  sharing_not_allowed: "payment",
  ticket_type_required: "ticket",
  not_on_sale: "ticket",
  too_many_tickets: "ticket",
};

/** Reads a nullable string field. */
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** The `guests.<n>.<field>` rows of the form (guest-fields.tsx). */
function guestsOf(fd: FormData) {
  const out: Array<{ firstName: string; lastName: string; email?: string; sharesBed?: boolean; payWith: "guest" | "order" }> = [];
  for (let i = 0; i < 10; i++) {
    const firstName = str(fd, `guests.${i}.firstName`);
    const lastName = str(fd, `guests.${i}.lastName`);
    if (!firstName && !lastName) continue;
    out.push({
      firstName: firstName ?? "",
      lastName: lastName ?? "",
      ...(str(fd, `guests.${i}.email`) ? { email: str(fd, `guests.${i}.email`) } : {}),
      ...(fd.get(`guests.${i}.sharesBed`) === "on" ? { sharesBed: true } : {}),
      payWith: str(fd, `guests.${i}.payWith`) === "order" ? "order" : "guest",
    });
  }
  return out;
}

/**
 * `/[locale]/account/book/[sessionId]` (booking spec 5.2, R16-R18, R28, R54-R56, R62, R62b):
 * the session and its booking form, or the waiting-list button when it is full, the opening time
 * when it is not open yet, "Closed for booking", or "For members" with the membership link.
 * A confirmed booking lands on its booking page; an order-paid one on commerce's
 * `/account/checkout/<orderId>`. Errors come back as `?error=<reason>` and are announced.
 */
export default async function BookSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; sessionId: string }>;
  searchParams: Promise<{ error?: string; joined?: string }>;
}) {
  const { locale: seg, sessionId } = await params;
  const locale = localeFromSegment(seg);
  if (!locale || !UUID.test(sessionId)) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const soft = softTranslator(locale);
  const { error, joined } = await searchParams;
  const db = await getAppDb();
  const view = await getBookableSession(db, actor.personId, sessionId).catch((e: unknown) => {
    if (e instanceof NotFoundError) return null;
    throw e;
  });
  if (!view || !view.session.publishedAt) notFound();
  const { session, availability } = view;
  const rules = await getSetting(db, "booking_rules");
  const here = `/${URL_SEGMENT[locale]}/account/book/${sessionId}`;

  const remaining = session.creditKind
    ? ((await getPersonCreditSummary(db, actor.personId).catch(() => null))?.byKind.find((k) => k.kind === session.creditKind)?.remainingUnits ?? null)
    : null;
  const quoteOf = (productId: string) =>
    getQuote(db, { personId: actor.personId, items: [{ productId, quantity: 1, sessionId }], channel: "portal" }).catch(() => null);
  const ticketed = view.ticketTypes.length > 0;
  const quote = session.productId && !ticketed && view.payOptions.includes("order") ? await quoteOf(session.productId) : null;
  // R51: each ticket type at its own product's quoted price.
  const ticketQuotes = await Promise.all(view.ticketTypes.map((t) => (t.state === "on_sale" ? quoteOf(t.productId) : Promise.resolve(null))));
  const termsLive = await getCurrentLegalVersion(db, "terms").catch(() => null);
  const termsRequired = termsLive ? !(await hasAcceptedCurrentTerms(db, actor.personId).catch(() => false)) : false;
  const termsHref = termsRequired ? ((await getLegalLinks(locale, db).catch(() => null))?.terms ?? null) : null;

  async function book(formData: FormData) {
    "use server";
    const payWith = (str(formData, "payWith") ?? "credit") as "credit" | "order" | "free";
    const name = str(formData, "emergency.name");
    const phone = str(formData, "emergency.phone");
    const relation = str(formData, "emergency.relation");
    const promo = str(formData, "promoCode");
    const ticketTypeId = str(formData, "ticketTypeId");
    const res = await bookSession({
      sessionId,
      ...(ticketTypeId && UUID.test(ticketTypeId) ? { ticketTypeId } : {}),
      payWith,
      guests: guestsOf(formData),
      clientKey: str(formData, "clientKey") ?? randomUUID(),
      ...(payWith === "order" && promo ? { promoCode: promo } : {}),
      ...(formData.get("acceptTerms") === "on" ? { acceptTerms: true } : {}),
      ...(name && phone ? { emergencyContact: { name, phone, ...(relation ? { relation } : {}) } } : {}),
    });
    if (!res.ok) {
      // Conflicts and named validation refusals (`ticket_type_required`, `too_many_tickets`, ...) carry their reason.
      const reason = res.error.code === "conflict" || res.error.code === "validation" ? res.error.message : res.error.code;
      redirect(`${here}?error=${encodeURIComponent(reason)}` as Route);
    }
    if (res.data.kind === "checkout") redirect(res.data.redirectTo as Route);
    redirect(`/${URL_SEGMENT[locale!]}/account/bookings/${res.data.bookingIds[0]}?done=booked` as Route);
  }

  async function join(formData: FormData) {
    "use server";
    const res = await joinWaitlist({ sessionId, acceptTerms: formData.get("acceptTerms") === "on" });
    if (!res.ok) {
      const reason = res.error.code === "conflict" ? res.error.message : res.error.code;
      redirect(`${here}?error=${encodeURIComponent(reason)}` as Route);
    }
    redirect(`${here}?joined=1` as Route);
  }

  const errorText = error ? (soft(`booking.errors.${error}`) !== `booking.errors.${error}` ? soft(`booking.errors.${error}`) : tr("booking.errors.generic")) : null;
  const freeUntil = freeCancelUntil(session.kind, session.startsAt, rules);
  const policy = freeUntil ? tr("booking.portalSession.policy", { date: formatDateTime(freeUntil, locale, "full") }) : tr("booking.portalSession.policy_never_free");

  const payOptions: PayOption[] = [];
  if (view.payOptions.includes("credit")) {
    // Credits take the person's own packages first, then the ones shared with them (credits rule 18,
    // R2): when their own units do not cover the session, the credit choice is the shared package.
    const ownCovers = remaining != null && remaining >= session.creditCost;
    const shared = !ownCovers ? view.sharedPackages[0] : undefined;
    payOptions.push(
      shared
        ? {
            value: "credit",
            label: tr("booking.portalSession.pay_shared"),
            hint: tr("booking.portalSession.shared_hint", { owner: shared.ownerName, count: shared.unitsForMe }),
          }
        : {
            value: "credit",
            label: tr("booking.portalSession.pay_credit"),
            hint: remaining != null ? tr("booking.portalSession.credits_left", { count: remaining }) : null,
          },
    );
  }
  if (view.payOptions.includes("order")) {
    payOptions.push({
      value: "order",
      label: tr("booking.portalSession.pay_single"),
      hint: quote ? tr("booking.portalSession.price_label", { price: formatMoney(quote.totalCents, locale) }) : null,
    });
  }
  if (view.payOptions.includes("free")) payOptions.push({ value: "free", label: tr("booking.portalSession.pay_free"), hint: null });

  // R51: the ticket type picker; a type that cannot be bought now is shown disabled with its reason.
  const ticketTypes: TicketTypeOption[] = view.ticketTypes.map((t, i) => {
    const q = ticketQuotes[i];
    const price = q ? formatMoney(q.totalCents, locale) : null;
    const hint =
      t.state === "not_yet" && t.salesStartAt
        ? tr("booking.portalSession.ticket_sales_from", { date: formatDateTime(t.salesStartAt, locale, "full") })
        : t.state === "not_on_sale"
          ? tr("booking.portalSession.ticket_not_on_sale")
          : t.state === "sold_out"
            ? tr("booking.portalSession.ticket_sold_out")
            : t.state === "members_only"
              ? tr("booking.portalSession.ticket_members_only")
              : t.left !== null
                ? tr("booking.portalSession.ticket_left", { count: t.left })
                : null;
    return { id: t.id, label: price ? `${pick(t.name, locale)} · ${price}` : pick(t.name, locale), hint, disabled: t.state !== "on_sale" };
  });
  const onSale = view.ticketTypes.filter((t) => t.state === "on_sale");

  // Guests: by the owner's package (R55, while credits allow a guest use) and/or by order (also on
  // a ticketed event, where every guest takes a ticket of the chosen type, R51, R52).
  const guestPay: Array<"guest" | "order"> = [];
  const guestUsesLeft = view.guestUses?.usesLeft ?? null;
  if (view.payOptions.includes("credit") && view.guestUses?.allowed) guestPay.push("guest");
  if (session.productId || ticketed) guestPay.push("order");
  const maxGuests = ticketed ? Math.min(view.maxGuests, Math.max(0, ...onSale.map((t) => t.maxPerBooking - 1))) : view.maxGuests;
  const usesLeftText =
    view.payOptions.includes("credit") && view.guestUses
      ? view.guestUses.allowed && guestUsesLeft !== null
        ? tr("booking.portalSession.guest_uses_left", { count: guestUsesLeft })
        : !view.guestUses.allowed && guestPay.length > 0
          ? tr("booking.portalSession.guest_uses_none")
          : null
      : null;
  const healthMissing = view.healthDeclaration ? !view.healthDeclaration.valid : false;
  // R22: a lead booking a Lead Magnet seat reserved for leads.
  const leadSeatNotice = availability.useLeadSeat ? tr("booking.portalSession.lead_seat_notice") : null;

  const title = pick(session.title, locale);
  const description = session.description ? pick(session.description, locale) : null;
  const when = `${formatDateTime(session.startsAt, locale, "full")} – ${formatTime(session.endsAt, locale)}`;
  const open = availability.reason === "ok";

  return (
    <section aria-labelledby="session-title" className="space-y-5">
      <Link href={`/${URL_SEGMENT[locale]}/account/book?tab=${session.kind}` as Route} className="text-sm underline">
        {tr("booking.common.back")}
      </Link>
      <header className="space-y-1">
        <h1 id="session-title" className="text-2xl font-semibold">
          {title}
        </h1>
        <p>
          <span className="sr-only">{tr("booking.portalSession.when")}: </span>
          {when}
        </p>
        {session.location ? (
          <p className="text-sm text-muted-foreground">
            <span className="sr-only">{tr("booking.portalSession.where")}: </span>
            {session.location}
          </p>
        ) : null}
        {description ? <p className="text-sm">{description}</p> : null}
      </header>

      {joined ? (
        <p role="status" className="rounded-md border p-3" data-testid="waitlist-joined">
          {tr("booking.portalSession.waitlist_joined")}
        </p>
      ) : null}

      {open ? (
        <BookForm
          action={book}
          clientKey={randomUUID()}
          payOptions={payOptions}
          showPromo={view.payOptions.includes("order")}
          ticketTypes={ticketed ? ticketTypes : null}
          leadSeatNotice={leadSeatNotice}
          guests={
            maxGuests > 0 && (session.kind !== "event" || ticketed)
              ? { max: maxGuests, isNight: session.kind === "night", payOptions: guestPay, usesLeft: usesLeftText }
              : null
          }
          terms={{ required: termsRequired, href: termsHref }}
          health={
            healthMissing
              ? { message: view.healthDeclarationRequired ? tr("booking.errors.health_declaration_required") : tr("booking.portalSession.health_notice"), href: `/${URL_SEGMENT[locale]}/f/health-declaration` }
              : null
          }
          emergency={view.needsEmergencyContact}
          policy={{ text: policy, notice: tr("booking.portalSession.no_withdrawal") }}
          error={errorText ? { message: errorText, field: error ? (FIELD_OF[error] ?? null) : null } : null}
          labels={{
            payment: tr("booking.portalSession.payment"),
            promoCode: tr("booking.portalSession.promo_code"),
            acceptTerms: tr("booking.portalSession.accept_terms"),
            readTerms: tr("booking.portalSession.read_terms"),
            healthLink: tr("booking.portalSession.health_link"),
            emergencyTitle: tr("booking.portalSession.emergency_title"),
            emergencyName: tr("booking.portalSession.emergency_name"),
            emergencyPhone: tr("booking.portalSession.emergency_phone"),
            emergencyRelation: tr("booking.portalSession.emergency_relation"),
            submit: tr("booking.portalSession.book"),
            noPayOption: tr("booking.portalSession.no_pay_option"),
            ticketType: tr("booking.portalSession.ticket_type"),
            guests: {
              legend: tr("booking.portalSession.guests"),
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
            },
          }}
        />
      ) : (
        <div className="space-y-3" data-testid="session-unavailable">
          {errorText ? (
            <p role="alert" className="rounded-md border border-destructive p-3 text-sm">
              {errorText}
            </p>
          ) : null}
          <p className="font-medium" data-testid="session-state">
            {availability.reason === "not_open_yet" && availability.opensAt
              ? tr("booking.portalSession.opens_at", { date: formatDateTime(availability.opensAt, locale, "full") })
              : tr(`booking.availability.${availability.reason === "member_only" ? "memberOnly" : availability.reason === "not_open_yet" ? "notOpenYet" : availability.reason}`)}
          </p>
          {availability.reason === "member_only" ? (
            <Link href={`/${URL_SEGMENT[locale]}/account/shop` as Route} className={buttonVariants({ variant: "outline" })}>
              {tr("booking.portalSession.membership_link")}
            </Link>
          ) : null}
          {availability.canJoinWaitlist && !joined ? (
            <form action={join} className="space-y-2">
              {termsRequired ? (
                <label className="flex min-h-11 items-center gap-3">
                  <input type="checkbox" name="acceptTerms" required className="size-5" />
                  <span>{tr("booking.portalSession.accept_terms")}</span>
                </label>
              ) : null}
              <button type="submit" className={buttonVariants({})} data-testid="join-waitlist">
                {availability.queue === "customer" ? tr("booking.portalSession.join_customer_queue") : tr("booking.portalSession.join_waitlist")}
              </button>
            </form>
          ) : null}
          <PolicyNote policy={policy} />
        </div>
      )}
    </section>
  );
}

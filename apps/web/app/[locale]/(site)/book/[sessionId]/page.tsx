import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { childrenAllowed } from "@beam/core/booking";
import { formatMoney, localeFromSegment, pick, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { softTranslator, translator } from "@/lib/i18n";
import { getSetting } from "@/lib/settings";
import { bookAsGuest, bookSession } from "@/modules/booking/actions";
import { getSessionCards } from "@/modules/booking/api";
import { getBookableSession, getBookingAddOns, getBookingOffers } from "@/modules/booking/queries";
import { GuestBookForm, type BookFormSession, type ExtraIcon, type GuestBookState } from "@/modules/booking/ui/site/guest-book-form";
import { getPersonCreditSummary } from "@/modules/credits/api";
import { getCurrentLegalVersion, getLegalLinks, hasAcceptedCurrentTerms } from "@/modules/site/api";
import { BookSteps, InfoCard, TrustStrip } from "@/modules/site/ui/public/book-flow";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TZ = "Europe/Brussels";
const MAX_KIDS = 10;
const MAX_COMPANIONS = 10;
const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;

/** The hidden `utm` field: a JSON object of short strings (validated again by the action's `Utm` schema). */
function readUtm(raw: string): Record<string, string> | undefined {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object") return undefined;
    const out: Record<string, string> = {};
    for (const k of UTM_KEYS) {
      const x = (parsed as Record<string, unknown>)[k];
      if (typeof x === "string" && x.trim()) out[k] = x.trim().slice(0, 200);
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  return locale ? { title: translator(locale)("site.bookFlow.metaTitle"), robots: { index: false } } : {};
}

/**
 * Owner decision: another adult is added by email only. The name comes from the address
 * ("jan.claes@…" is Jan Claes) until they complete their own profile.
 */
function namesFromEmail(email: string): { firstName: string; lastName: string } {
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const local = email.split("@")[0] ?? "";
  const [first, ...rest] = local.split(/[._+-]+/).filter(Boolean);
  // ponytail: "-" as last name for one-word addresses; the person record keeps the email, so staff can complete it.
  return { firstName: cap(first ?? local).slice(0, 100) || "-", lastName: rest.map(cap).join(" ").slice(0, 100) || "-" };
}

/** The tile icon of a booking extra without a photo. */
function extraIcon(sku: string, category: string | null): ExtraIcon {
  if (category === "drink") return "drink";
  if (category === "food") return "food";
  if (/robe/i.test(sku)) return "robe";
  if (category === "wellness_product") return "salt";
  return "gift";
}

/**
 * The submitted form as the actions' input. `pay` is `credit` (the client's own package), `order`
 * (this session) or `package` with `packagePick=<productId>` (buy that package, this booking uses one session).
 */
function readForm(fd: FormData) {
  const v = (k: string) => {
    const x = fd.get(k);
    return typeof x === "string" ? x.trim() : "";
  };
  const pay = v("pay");
  const packageProductId = pay === "package" && UUID.test(v("packagePick")) ? v("packagePick") : undefined;
  const children: Array<{ firstName: string; ageGroup: "child" | "youth" }> = [];
  for (let i = 0; i < MAX_KIDS; i++) {
    const firstName = v(`kids.${i}.firstName`);
    const ageGroup = v(`kids.${i}.ageGroup`);
    if (firstName && (ageGroup === "child" || ageGroup === "youth")) children.push({ firstName, ageGroup });
  }
  // Owner decisions: other adults, extras, more sessions in the same payment, a code, the campaign.
  const companions: Array<{ firstName: string; lastName: string; email?: string; sharesBed?: boolean }> = [];
  for (let i = 0; i < MAX_COMPANIONS; i++) {
    const email = v(`companions.${i}.email`);
    if (email) companions.push({ ...namesFromEmail(email), email, ...(fd.get(`companions.${i}.sharesBed`) === "on" ? { sharesBed: true } : {}) });
  }
  const extras: Array<{ productId: string; quantity: number }> = [];
  const moreSessionIds: string[] = [];
  for (const [k, x] of fd.entries()) {
    if (typeof x !== "string") continue;
    const id = k.slice(k.indexOf(".") + 1);
    if (k.startsWith("extras.") && UUID.test(id) && Number(x) > 0) extras.push({ productId: id, quantity: Math.min(10, Math.floor(Number(x))) });
    if (k.startsWith("more.") && UUID.test(id) && x === "on") moreSessionIds.push(id);
  }
  const code = v("code");
  const utm = readUtm(v("utm"));
  const name = v("emergency.name");
  const phone = v("emergency.phone");
  const values: Record<string, string> = {};
  for (const [k, x] of fd.entries()) if (typeof x === "string" && k !== "clientKey" && k !== "utm" && !k.startsWith("$")) values[k] = x;
  return {
    v,
    values,
    pay,
    packageProductId,
    companions,
    common: {
      children,
      moreSessionIds,
      extras,
      ...(code ? { code } : {}),
      ...(utm ? { utm } : {}),
      clientKey: UUID.test(v("clientKey")) ? v("clientKey") : randomUUID(),
      ...(fd.get("acceptTerms") === "on" ? { acceptTerms: true } : {}),
      ...(name && phone ? { emergencyContact: { name, phone } } : {}),
    },
  };
}

/** The error message of a refused booking (booking's, else commerce's for codes and vouchers), and the form fields it names. */
function refusal(locale: Locale, error: { code: string; message: string; fields?: Record<string, string> }): { message: string; fields: string[] } {
  const soft = softTranslator(locale);
  const key = [`booking.errors.${error.message}`, `commerce.errors.${error.message}`, `commerce.errors.${error.code}`].find((k) => soft(k) !== k);
  const fallback = error.code === "validation" ? "booking.errors.validation" : "booking.errors.generic";
  const fields = Object.keys(error.fields ?? {}).map((f) =>
    f.startsWith("emergencyContact.") ? f.replace("emergencyContact.", "emergency.") : f === "promoCode" || f === "code" ? "code" : f.startsWith("guests.") ? f.replace("guests.", "companions.") : f,
  );
  return { message: soft(key ?? fallback), fields };
}

/**
 * `/[locale]/book/<sessionId>`: the chosen session and step 1 of booking without an account
 * (owner's review 8). A guest gives email, full name and phone; a signed-in client books as
 * themselves. Both choose how to pay: this session (Stripe Checkout offers Bancontact, card, ...),
 * their own day or night package, or a package bought now with its saving shown (owner's review
 * 3). Children come along on sessions that take them (owner's review 1). The submit holds the
 * seat and leads to step 2, review and pay (`/checkout/pay/<orderId>` for a guest,
 * `/account/checkout/<orderId>` when signed in).
 */
export default async function PublicBookSessionPage({ params, searchParams }: { params: Promise<{ locale: string; sessionId: string }>; searchParams: Promise<{ booked?: string; more?: string }> }) {
  const { locale: seg, sessionId } = await params;
  const locale = localeFromSegment(seg);
  if (!locale || !UUID.test(sessionId)) notFound();
  const tr = translator(locale);
  const sp = await searchParams;
  const db = await getAppDb();
  const [card] = await getSessionCards(db, [sessionId], locale);
  if (!card) notFound();
  const session = await getSession();
  const actor = actorFromSession(session);
  const customer = actor?.kind === "customer" ? actor : null;
  const prices = await getBookingOffers(db, sessionId).catch(() => ({ singleCents: null, childCents: { child: null, youth: null }, offers: [] }));
  const rules = await getSetting(db, "booking_rules");

  const prefix = `/${URL_SEGMENT[locale]}`;
  const here = `${prefix}/book/${sessionId}`;
  const kind = card.kind === "night" ? "night" : "day";
  // Owner requirements 4 and 5: an event shows its own artwork; a free event says so; a webinar is online.
  const heroImage = card.imageFileId ? `/api/public/files/${card.imageFileId}` : `/brand/book-${kind}.webp`;
  const isFree = card.kind === "event" && !card.productId;
  const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts });
  const dateLine = fmt({ weekday: "long", day: "numeric", month: "long" }).format(card.startsAt);
  const timeLine = `${fmt({ hour: "2-digit", minute: "2-digit" }).format(card.startsAt)} – ${fmt({ hour: "2-digit", minute: "2-digit" }).format(card.endsAt)}`;
  const full = card.availabilityBand === "full";
  const money = (cents: number) => formatMoney(cents, locale);

  // Signed in: their package, emergency contact and terms state, as on the portal booking page.
  const view = customer ? await getBookableSession(db, customer.personId, sessionId).catch(() => null) : null;
  const creditsLeft =
    customer && view?.payOptions.includes("credit") && view.session.creditKind
      ? ((await getPersonCreditSummary(db, customer.personId).catch(() => null))?.byKind.find((k) => k.kind === view.session.creditKind)?.remainingUnits ?? null)
      : null;
  const termsLive = await getCurrentLegalVersion(db, "terms").catch(() => null);
  const termsNeeded = termsLive ? (customer ? !(await hasAcceptedCurrentTerms(db, customer.personId).catch(() => false)) : true) : false;
  const termsHref = termsNeeded ? ((await getLegalLinks(locale, db).catch(() => null))?.terms ?? null) : null;
  const emergency = customer ? !!view?.needsEmergencyContact : card.kind === "night" && rules.require_emergency_contact_for_nights;
  const kidsAllowed = childrenAllowed({ kind: card.kind, startsAt: card.startsAt }) && rules.max_guests_per_booking > 0 && prices.childCents.child !== null && prices.childCents.youth !== null;
  // Owner decisions: extras, and the other sessions picked on the moment page (`?more=<id>,<id>`),
  // kept only when they are bookable sessions of the next seven days.
  const addOns = card.kind === "event" ? { extras: [], moreSessions: [] } : await getBookingAddOns(db, sessionId).catch(() => ({ extras: [], moreSessions: [] }));
  const dayFmt = fmt({ weekday: "long", day: "numeric", month: "long" });
  const hm = fmt({ hour: "2-digit", minute: "2-digit" });
  const formSession: BookFormSession = {
    sessionId,
    kind: card.kind === "night" ? "night" : card.kind === "day" ? "day" : "event",
    day: dateLine,
    time: timeLine,
    priceCents: prices.singleCents,
    youthCents: prices.childCents.youth,
    childrenAllowed: kidsAllowed,
  };
  const picked = new Set((sp.more ?? "").split(",").filter((id) => UUID.test(id)));
  const moreSessions: BookFormSession[] = addOns.moreSessions.filter((m) => picked.has(m.sessionId)).map((m) => ({
    sessionId: m.sessionId,
    kind: m.kind,
    day: dayFmt.format(m.startsAt),
    time: `${hm.format(m.startsAt)} – ${hm.format(m.endsAt)}`,
    priceCents: m.singleCents,
    youthCents: m.youthCents,
    childrenAllowed: m.childrenAllowed,
  }));

  const payOptions: Array<{ value: string; label: string; hint: string | null }> = [];
  if (customer && view?.payOptions.includes("credit")) {
    payOptions.push({ value: "credit", label: tr("site.bookFlow.guest.payCredit"), hint: creditsLeft !== null ? tr("site.bookFlow.guest.payCreditHint", { count: creditsLeft }) : null });
  }
  if (card.productId && prices.singleCents !== null) {
    payOptions.push({ value: "order", label: tr("site.bookFlow.guest.payOrder", { price: money(prices.singleCents) }), hint: tr("site.bookFlow.guest.payOrderHint") });
  }
  // Owner: one "buy a package" option with a dropdown of the packages and their saving.
  const bestPct = Math.max(0, ...prices.offers.map((o) => o.savingPct ?? 0));
  const packages = prices.offers.length
    ? {
        title: bestPct ? tr("site.bookFlow.guest.payPackageChoice", { pct: bestPct }) : tr("site.bookFlow.guest.payPackageChoicePlain"),
        items: prices.offers.map((o) => {
          const per = money(o.perSessionCents);
          const name = pick(o.name, locale);
          return {
            productId: o.productId,
            priceCents: o.priceCents,
            kind,
            label: o.savingPct ? tr("site.bookFlow.packages.optionSave", { name, price: money(o.priceCents), pct: o.savingPct }) : tr("site.bookFlow.packages.option", { name, price: money(o.priceCents) }),
            detail:
              o.savingPct !== null && prices.singleCents !== null
                ? tr("site.bookFlow.guest.payPackageSaving", { per, single: money(prices.singleCents), pct: o.savingPct })
                : tr("site.bookFlow.guest.payPackageHint", { per }),
          };
        }),
      }
    : null;

  const signedIn = !!customer;
  const user = session?.user;
  async function submit(prev: GuestBookState, fd: FormData): Promise<GuestBookState> {
    "use server";
    const loc = localeFromSegment(seg) ?? "nl-BE";
    const form = readForm(fd);
    const res = signedIn
      ? await bookSession({
          sessionId,
          ...form.common,
          payWith: form.pay === "order" ? "order" : "credit",
          ...(form.packageProductId ? { buyPackageProductId: form.packageProductId } : {}),
          guests: form.companions.map((c) => ({ ...c, payWith: "order" as const })),
        })
      : await bookAsGuest({
          sessionId,
          ...form.common,
          email: form.v("email"),
          firstName: form.v("firstName"),
          lastName: form.v("lastName"),
          phone: form.v("phone"),
          pay: form.packageProductId ? "package" : "order",
          ...(form.packageProductId ? { packageProductId: form.packageProductId } : {}),
          companions: form.companions,
        });
    if (res.ok) {
      if (res.data.kind === "checkout") redirect(res.data.redirectTo as never);
      redirect((signedIn ? `/${seg}/account/bookings/${res.data.bookingIds[0]}?done=booked` : `/${seg}/book/${sessionId}?booked=1`) as never);
    }
    const { message, fields } = refusal(loc, res.error);
    return { error: message, fields, values: form.values, n: prev.n + 1 };
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <BookSteps current={3} tr={tr} />
      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-8">
          <section aria-labelledby="session-title" className="relative isolate overflow-hidden rounded-[2rem] p-7 text-[#fffaef] sm:p-10">
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand photo */}
            <img src={heroImage} alt="" className="absolute inset-0 -z-20 h-full w-full object-cover" />
            <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[linear-gradient(110deg,rgba(23,28,48,0.94)_0%,rgba(23,28,48,0.78)_55%,rgba(23,28,48,0.35)_100%)]" />
            <p className="text-xs font-semibold tracking-[0.25em] text-[#d1a64a] uppercase">{tr("site.bookFlow.s3.title")}</p>
            <h1 id="session-title" className="font-display mt-2 text-4xl sm:text-5xl">
              {card.title}
            </h1>
            <dl className="mt-6 grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs tracking-widest text-[#fffaef]/60 uppercase">{tr("site.bookFlow.summary.when")}</dt>
                <dd className="mt-1 font-medium first-letter:uppercase">{dateLine}</dd>
                <dd className="text-[#fffaef]/80 tabular-nums">{timeLine}</dd>
              </div>
              <div>
                <dt className="text-xs tracking-widest text-[#fffaef]/60 uppercase">{tr("site.bookFlow.summary.where")}</dt>
                <dd className="mt-1 font-medium">{card.location ?? (card.eventCategory === "webinar" ? tr("site.bookFlow.summary.online") : tr("site.bookFlow.summary.whereValue"))}</dd>
              </div>
              {prices.singleCents !== null ? (
                <div>
                  <dt className="text-xs tracking-widest text-[#fffaef]/60 uppercase">{tr("site.bookFlow.summary.price")}</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">{money(prices.singleCents)}</dd>
                </div>
              ) : isFree ? (
                <div>
                  <dt className="text-xs tracking-widest text-[#fffaef]/60 uppercase">{tr("site.bookFlow.summary.price")}</dt>
                  <dd className="mt-1 text-2xl font-semibold">{tr("site.bookFlow.summary.free")}</dd>
                </div>
              ) : null}
            </dl>
            <a href={`${prefix}/book?kind=${kind}`} className="mt-6 inline-block text-sm text-[#fffaef]/80 underline underline-offset-4 hover:text-[#fffaef]">
              {tr("site.bookFlow.summary.change")}
            </a>
          </section>

          {sp.booked ? (
            <p role="status" className="rounded-2xl bg-[#e7f1ea] p-5" data-testid="guest-booked">
              {tr("site.bookFlow.guest.booked")}
            </p>
          ) : full ? (
            <p role="status" className="rounded-2xl border border-border bg-card p-5">
              {tr("site.bookFlow.full")}
            </p>
          ) : payOptions.length === 0 && !packages ? (
            <p role="status" className="rounded-2xl border border-border bg-card p-5">
              {tr("site.bookFlow.guest.noPayOption")}
            </p>
          ) : (
            <section aria-label={tr("site.bookFlow.steps.details")} className="rounded-[2rem] border border-border bg-card p-6 sm:p-10">
              <GuestBookForm
                action={submit}
                clientKey={randomUUID()}
                locale={locale}
                signedIn={signedIn}
                loginHref={`${prefix}/account/login?returnTo=${encodeURIComponent(here)}`}
                payOptions={payOptions}
                packages={packages}
                kids={kidsAllowed ? { max: Math.min(MAX_KIDS, rules.max_guests_per_booking) } : null}
                companions={card.kind !== "event" && rules.max_guests_per_booking > 0 ? { max: Math.min(MAX_COMPANIONS, rules.max_guests_per_booking), sharedBeds: rules.max_shared_bed_guests_per_booking } : null}
                extras={addOns.extras.map((e) => ({
                  productId: e.productId,
                  name: pick(e.name, locale),
                  priceCents: e.priceCents,
                  price: money(e.priceCents),
                  kinds: e.kinds,
                  icon: extraIcon(e.sku, e.itemCategory),
                  imageUrl: e.imageFileId ? `/api/public/files/${e.imageFileId}` : null,
                }))}
                session={formSession}
                moreSessions={moreSessions}
                emergency={emergency}
                emergencyIfNight={rules.require_emergency_contact_for_nights}
                terms={termsNeeded ? { href: termsHref } : null}
                labels={{
                  detailsTitle: tr("site.bookFlow.guest.title"),
                  detailsIntro: tr("site.bookFlow.guest.intro"),
                  email: tr("site.bookFlow.account.email"),
                  firstName: tr("site.bookFlow.account.firstName"),
                  lastName: tr("site.bookFlow.account.lastName"),
                  phone: tr("site.bookFlow.guest.phone"),
                  signInTitle: tr("site.bookFlow.account.existing"),
                  signInBody: tr("site.bookFlow.guest.signInBody"),
                  signIn: tr("site.bookFlow.account.login"),
                  signedIn: user ? tr("site.bookFlow.guest.signedIn", { name: user.name ?? user.email, email: user.email }) : null,
                  payTitle: tr("site.bookFlow.guest.payTitle"),
                  packagePick: tr("site.bookFlow.guest.packagePick"),
                  kidsTitle: tr("site.bookFlow.guest.kidsTitle"),
                  kidsBody: tr("site.bookFlow.guest.kidsBody", { youth: money(prices.childCents.youth ?? 0) }),
                  kidFirstName: tr("site.bookFlow.guest.kidFirstName", { n: "{n}" }),
                  kidAge: tr("site.bookFlow.guest.kidAge"),
                  ageNone: tr("site.bookFlow.guest.ageNone"),
                  ageChild: tr("site.bookFlow.guest.ageChild"),
                  ageYouth: tr("site.bookFlow.guest.ageYouth", { price: money(prices.childCents.youth ?? 0) }),
                  emergencyTitle: tr("booking.portalSession.emergency_title"),
                  emergencyName: tr("booking.portalSession.emergency_name"),
                  emergencyPhone: tr("booking.portalSession.emergency_phone"),
                  acceptTerms: tr("booking.portalSession.accept_terms"),
                  readTerms: tr("booking.portalSession.read_terms"),
                  submit: tr("site.bookFlow.guest.submit"),
                  next: tr("site.bookFlow.guest.next"),
                  companionsTitle: tr("site.bookFlow.guest.companionsTitle"),
                  companionsBody: tr("site.bookFlow.guest.companionsBody", { max: Math.min(MAX_COMPANIONS, rules.max_guests_per_booking) }),
                  companion: tr("site.bookFlow.guest.companion", { n: "{n}" }),
                  companionEmail: tr("site.bookFlow.guest.companionEmail"),
                  sharesBed: tr("site.bookFlow.guest.sharesBed"),
                  addCompanion: tr("site.bookFlow.guest.addCompanion"),
                  removeCompanion: tr("site.bookFlow.guest.removeCompanion"),
                  extrasTitle: tr("site.bookFlow.guest.extrasTitle"),
                  extrasBody: tr("site.bookFlow.guest.extrasBody"),
                  extraAdd: tr("site.bookFlow.guest.extraAdd"),
                  fewer: tr("site.bookFlow.guest.extraFewer", { name: "{name}" }),
                  more: tr("site.bookFlow.guest.extraMore", { name: "{name}" }),
                  removeSession: tr("site.bookFlow.guest.removeSession", { when: "{when}" }),
                  kindDay: tr("site.bookFlow.day.title"),
                  kindNight: tr("site.bookFlow.night.title"),
                  codeTitle: tr("site.bookFlow.guest.codeTitle"),
                  codeLabel: tr("site.bookFlow.guest.codeLabel"),
                  codeHint: tr("site.bookFlow.guest.codeHint"),
                  summaryTitle: tr("site.bookFlow.guest.summaryTitle"),
                  seats: tr("site.bookFlow.guest.seats", { n: "{n}" }),
                  total: tr("site.bookFlow.summary.total"),
                  totalHint: tr("site.bookFlow.guest.totalHint"),
                }}
              />
            </section>
          )}
          <TrustStrip tr={tr} />
        </div>
        <aside className="space-y-4">
          <InfoCard title={tr("site.bookFlow.bring.title")}>
            <p>{tr("site.bookFlow.bring.body")}</p>
          </InfoCard>
          <InfoCard title={tr("site.bookFlow.after.title")}>
            <p>{tr("site.bookFlow.after.body")}</p>
          </InfoCard>
        </aside>
      </div>
    </div>
  );
}

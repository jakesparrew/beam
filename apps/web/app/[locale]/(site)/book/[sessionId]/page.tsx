import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { formatMoney, localeFromSegment, URL_SEGMENT } from "@beam/core/i18n";
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getSessionCards } from "@/modules/booking/api";
import { getProductPrice } from "@/modules/commerce/api";
import { customerSignUp } from "@/modules/platform/actions";
import { ArrowBadge, goldButtonClass } from "@/modules/site/ui/public/block-renderer";
import { BookSteps, InfoCard, TrustStrip } from "@/modules/site/ui/public/book-flow";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERRORS = new Set(["account_exists", "password_policy"]);
const TZ = "Europe/Brussels";
/** The seeded pricing page per locale (packages and memberships). */
const PRICING_PATH = { "nl-BE": "prijzen", "fr-BE": "tarifs", en: "prices" } as const;

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const locale = localeFromSegment((await params).locale);
  return locale ? { title: translator(locale)("site.bookFlow.metaTitle"), robots: { index: false } } : {};
}

const field = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};

/**
 * `/[locale]/book/<sessionId>`: step 3 of the public booking flow. The chosen session with price,
 * what to expect and how to prepare, then the account step: a new visitor creates an account in
 * one form (`auth.customer_sign_up`, signed in at once), a known one logs in; both land on the
 * portal's booking form (`/account/book/<id>`, step 4: payment or package credit).
 */
export default async function PublicBookSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; sessionId: string }>;
  searchParams: Promise<{ error?: string; email?: string; first?: string; last?: string }>;
}) {
  const { locale: seg, sessionId } = await params;
  const locale = localeFromSegment(seg);
  if (!locale || !UUID.test(sessionId)) notFound();
  const tr = translator(locale);
  const sp = await searchParams;
  const db = await getAppDb();
  const [card] = await getSessionCards(db, [sessionId], locale);
  if (!card) notFound();
  const price = card.productId ? await getProductPrice(db, card.productId, "public").catch(() => null) : null;
  const actor = actorFromSession(await getSession());
  const signedIn = actor?.kind === "customer" ? (await getSession())?.user : null;

  const prefix = `/${URL_SEGMENT[locale]}`;
  const here = `${prefix}/book/${sessionId}`;
  const portalBook = `${prefix}/account/book/${sessionId}`;
  const kind = card.kind === "night" ? "night" : "day";
  const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { timeZone: TZ, ...opts });
  const dateLine = fmt({ weekday: "long", day: "numeric", month: "long" }).format(card.startsAt);
  const timeLine = `${fmt({ hour: "2-digit", minute: "2-digit" }).format(card.startsAt)} – ${fmt({ hour: "2-digit", minute: "2-digit" }).format(card.endsAt)}`;
  const full = card.availabilityBand === "full";
  const error = sp.error ? (ERRORS.has(sp.error) ? sp.error : "generic") : null;

  async function signUp(fd: FormData) {
    "use server";
    const email = field(fd, "email");
    const firstName = field(fd, "firstName");
    const lastName = field(fd, "lastName");
    const res = await customerSignUp({ email, firstName, lastName, password: (fd.get("password") as string | null) ?? "", locale: locale!, returnTo: portalBook });
    if (res.ok) redirect(res.data.next as never);
    const reason = res.error.message === "account_exists" || res.error.message === "password_policy" ? res.error.message : "generic";
    const q = new URLSearchParams({ error: reason, email, first: firstName, last: lastName });
    redirect(`${here}?${q.toString()}#account` as never);
  }

  const input = "h-12 w-full rounded-xl border border-input bg-card px-4 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 lg:px-8">
      <BookSteps current={3} tr={tr} />
      <div className="grid gap-8 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-8">
          <section aria-labelledby="session-title" className="relative isolate overflow-hidden rounded-[2rem] p-7 text-[#fffaef] sm:p-10">
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand photo */}
            <img src={`/brand/book-${kind}.webp`} alt="" className="absolute inset-0 -z-20 h-full w-full object-cover" />
            <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[linear-gradient(110deg,rgba(23,28,48,0.94)_0%,rgba(23,28,48,0.78)_55%,rgba(23,28,48,0.35)_100%)]" />
            <p className="text-xs font-semibold tracking-[0.25em] text-[#ffd76a] uppercase">{tr("site.bookFlow.s3.title")}</p>
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
                <dd className="mt-1 font-medium">{card.location ?? tr("site.bookFlow.summary.whereValue")}</dd>
              </div>
              {price ? (
                <div>
                  <dt className="text-xs tracking-widest text-[#fffaef]/60 uppercase">{tr("site.bookFlow.summary.price")}</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatMoney(price.amountCents, locale)}</dd>
                </div>
              ) : null}
            </dl>
            <a href={`${prefix}/book?kind=${kind}`} className="mt-6 inline-block text-sm text-[#fffaef]/80 underline underline-offset-4 hover:text-[#fffaef]">
              {tr("site.bookFlow.summary.change")}
            </a>
          </section>

          {full ? (
            <p role="status" className="rounded-2xl border border-border bg-card p-5">
              {tr("site.bookFlow.full")}
            </p>
          ) : signedIn ? (
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-[2rem] border border-border bg-card p-6 sm:p-8">
              <p className="text-lg">{tr("site.bookFlow.account.signedIn", { name: signedIn.name ?? signedIn.email })}</p>
              <a href={portalBook} className={`${goldButtonClass} py-2 pr-2 pl-6`}>
                {tr("site.bookFlow.account.continue")}
                <ArrowBadge dark />
              </a>
            </section>
          ) : (
            <section id="account" aria-labelledby="account-title" className="rounded-[2rem] border border-border bg-card p-6 sm:p-10">
              <h2 id="account-title" className="font-display text-3xl">
                {tr("site.bookFlow.account.title")}
              </h2>
              <p className="mt-2 max-w-xl text-muted-foreground">{tr("site.bookFlow.account.intro")}</p>
              {error ? (
                <p role="alert" className="mt-5 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm">
                  {tr(`site.bookFlow.errors.${error}`)}
                  {error === "account_exists" ? (
                    <>
                      {" "}
                      <a href={`${prefix}/account/login?returnTo=${encodeURIComponent(portalBook)}`} className="font-semibold underline">
                        {tr("site.bookFlow.account.login")}
                      </a>
                    </>
                  ) : null}
                </p>
              ) : null}
              <div className="mt-6 grid gap-8 md:grid-cols-[1.4fr_1fr]">
                <form action={signUp} className="grid gap-4">
                  <h3 className="font-semibold">{tr("site.bookFlow.account.new")}</h3>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="grid gap-1.5 text-sm font-medium">
                      {tr("site.bookFlow.account.firstName")}
                      <input name="firstName" required autoComplete="given-name" maxLength={100} defaultValue={sp.first ?? ""} className={input} />
                    </label>
                    <label className="grid gap-1.5 text-sm font-medium">
                      {tr("site.bookFlow.account.lastName")}
                      <input name="lastName" required autoComplete="family-name" maxLength={100} defaultValue={sp.last ?? ""} className={input} />
                    </label>
                  </div>
                  <label className="grid gap-1.5 text-sm font-medium">
                    {tr("site.bookFlow.account.email")}
                    <input name="email" type="email" required autoComplete="email" maxLength={254} defaultValue={sp.email ?? ""} className={input} />
                  </label>
                  <label className="grid gap-1.5 text-sm font-medium">
                    {tr("site.bookFlow.account.password")}
                    <input name="password" type="password" required minLength={10} autoComplete="new-password" className={input} aria-describedby="pw-hint" />
                    <span id="pw-hint" className="text-xs font-normal text-muted-foreground">
                      {tr("site.bookFlow.account.passwordHint")}
                    </span>
                  </label>
                  <button type="submit" className={`${goldButtonClass} mt-2 justify-self-start py-2 pr-2 pl-6`}>
                    {tr("site.bookFlow.account.submit")}
                    <ArrowBadge dark />
                  </button>
                </form>
                <div className="grid content-start gap-3 rounded-2xl bg-[#f4ead3] p-6">
                  <h3 className="font-semibold">{tr("site.bookFlow.account.existing")}</h3>
                  <p className="text-sm text-[#212842]/75">{tr("site.bookFlow.account.existingBody")}</p>
                  <a
                    href={`${prefix}/account/login?returnTo=${encodeURIComponent(portalBook)}`}
                    className="inline-flex items-center justify-center justify-self-start rounded-full bg-[#212842] px-6 py-3 text-sm font-semibold text-[#fffaef] hover:bg-[#2b3354]"
                  >
                    {tr("site.bookFlow.account.login")}
                  </a>
                </div>
              </div>
            </section>
          )}
          <TrustStrip tr={tr} />
        </div>
        <aside className="space-y-4">
          <InfoCard title={tr("site.bookFlow.package.title")} tone="sand">
            <p className="text-[#212842]/80">{tr("site.bookFlow.package.body")}</p>
            <a href={`${prefix}/${PRICING_PATH[locale]}`} className="inline-block pt-1 font-semibold text-[#212842] underline underline-offset-4">
              {tr("site.bookFlow.package.link")} →
            </a>
          </InfoCard>
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

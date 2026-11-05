import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { URL_SEGMENT, formatDateTime, localeFromSegment } from "@beam/core/i18n";
import { Button, EmptyState } from "@beam/ui";
import { spokenLanguageName, titleIn, webinarDate } from "@beam/email/templates/webinar";
import { requireCustomer } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { getCurrentConsents } from "@/modules/crm/api";
import { cancelMyRegistration } from "@/modules/webinar/actions";
import { listMyWebinars, listPublicWebinarRows, registrationFormLabels, type MyWebinarItem } from "@/modules/webinar/queries";
import { WEBINAR_CONSENT_WORDING_VERSION } from "@/modules/webinar/server/registration";
import { RegistrationForm } from "@/modules/webinar/ui/registration-form";
import { WebinarCard } from "@/modules/webinar/ui/webinar-card";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string }>; searchParams: Promise<{ done?: string; error?: string }> };

/**
 * `/[locale]/account/webinars` (webinar spec 5.2, behind `ff_webinar_portal`): Upcoming
 * (registered, with "add to calendar"), Watch again (replays still available to this
 * registration, with the end date and the views left) and the On-demand library (published
 * on-demand webinars in this locale). One-click registration (the consent boxes are shown once,
 * until the person answered both), cancel and watch. Empty state "You have no webinars yet." plus
 * the public list. Buttons are plain forms posting server actions.
 */
export default async function MyWebinarsPage({ params, searchParams }: Props) {
  const { locale: seg } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  const actor = await requireCustomer(locale);
  if (!(await flag("ff_webinar_portal", actor))) notFound();
  const tr = translator(locale);
  const { done, error } = await searchParams;
  const db = await getAppDb();
  const now = new Date();
  const mine = await listMyWebinars(db, actor.personId, locale, now);
  const consents = await getCurrentConsents(db, actor.personId).catch(() => null);
  const showConsents = !consents || consents.events === null || consents.newsletter === null;
  const here = `/${URL_SEGMENT[locale]}/account/webinars`;
  const registeredIds = new Set([...mine.upcoming, ...mine.watchAgain, ...mine.onDemand].filter((x) => x.registration).map((x) => x.webinar.id));
  const discover = (await listPublicWebinarRows(db, { locale, from: now, limit: 20 })).filter((w) => w.mode !== "on_demand" && !registeredIds.has(w.id));
  const labels = registrationFormLabels(tr);

  async function cancel(formData: FormData) {
    "use server";
    const res = await cancelMyRegistration({ registrationId: String(formData.get("registrationId") ?? "") });
    redirect((res.ok ? `${here}?done=cancelled` : `${here}?error=1`) as Route);
  }

  const language = (x: MyWebinarItem) => tr("webinar.public.card.language", { language: spokenLanguageName(x.webinar.spokenLocale, locale) });
  const title = (x: MyWebinarItem) => titleIn(x.webinar.title as Record<string, string>, locale);
  const watchHref = (id: string) => `/${URL_SEGMENT[locale]}/account/webinars/${id}`;
  const cancelForm = (registrationId: string) => (
    <form action={cancel}>
      <input type="hidden" name="registrationId" value={registrationId} />
      <Button type="submit" variant="outline" size="sm">
        {tr("webinar.portal.list.cancel")}
      </Button>
    </form>
  );
  const availability = (x: MyWebinarItem) => [
    x.availableUntil ? tr("webinar.portal.list.available_until", { date: formatDateTime(x.availableUntil, locale, "long") }) : tr("webinar.portal.list.no_expiry"),
    ...(x.viewsLeft !== null ? [tr("webinar.portal.list.views_left", { count: x.viewsLeft })] : []),
  ];
  const registerForm = (webinarId: string, slug: string) => (
    <RegistrationForm
      variant="portal"
      webinarId={webinarId}
      slug={slug}
      locale={locale}
      wordingVersion={WEBINAR_CONSENT_WORDING_VERSION}
      privacyHref={`/${URL_SEGMENT[locale]}/privacy`}
      labels={labels}
      showConsents={showConsents}
    />
  );
  const nothing = !mine.upcoming.length && !mine.watchAgain.length && !mine.onDemand.some((x) => x.registration);

  return (
    <section aria-labelledby="my-webinars-title" className="space-y-8">
      <h1 id="my-webinars-title" className="text-2xl font-semibold">
        {tr("webinar.portal.list.title")}
      </h1>
      <div aria-live="polite">
        {done ? (
          <p role="status" className="rounded-md border border-border p-3 text-sm">
            {tr("webinar.portal.list.cancelled")}
          </p>
        ) : null}
        {error ? <p className="rounded-md border border-destructive p-3 text-sm">{tr("webinar.portal.list.error")}</p> : null}
      </div>
      {nothing ? <EmptyState title={tr("webinar.portal.list.empty")} /> : null}

      {mine.upcoming.length ? (
        <section aria-labelledby="my-webinars-upcoming" className="space-y-3">
          <h2 id="my-webinars-upcoming" className="text-xl font-semibold">
            {tr("webinar.portal.list.upcoming")}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {mine.upcoming.map((x) => (
              <li key={x.webinar.id}>
                <WebinarCard
                  title={title(x)}
                  href={watchHref(x.webinar.id)}
                  when={tr("webinar.public.landing.date", { date: webinarDate(x.webinar.startsAt, locale) })}
                  language={language(x)}
                  badge={x.webinar.status === "live" ? tr("webinar.public.card.live_now") : tr("webinar.portal.list.registered")}
                  action={tr("webinar.portal.list.watch")}
                >
                  <a href={`/api/public/webinars/${x.webinar.slug}/ics?locale=${locale}`} className="text-sm underline underline-offset-2">
                    {tr("webinar.portal.list.calendar")}
                  </a>
                  {x.registration ? cancelForm(x.registration.id) : null}
                </WebinarCard>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {mine.watchAgain.length ? (
        <section aria-labelledby="my-webinars-again" className="space-y-3">
          <h2 id="my-webinars-again" className="text-xl font-semibold">
            {tr("webinar.portal.list.watch_again")}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {mine.watchAgain.map((x) => (
              <li key={x.webinar.id}>
                <WebinarCard title={title(x)} href={watchHref(x.webinar.id)} when={webinarDate(x.webinar.startsAt, locale)} language={language(x)} details={availability(x)} action={tr("webinar.portal.list.watch")} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {mine.onDemand.length ? (
        <section aria-labelledby="my-webinars-on-demand" className="space-y-3">
          <h2 id="my-webinars-on-demand" className="text-xl font-semibold">
            {tr("webinar.portal.list.on_demand")}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {mine.onDemand.map((x) => (
              <li key={x.webinar.id}>
                <WebinarCard
                  title={title(x)}
                  href={x.registration ? watchHref(x.webinar.id) : `/${URL_SEGMENT[locale]}/webinars/${x.webinar.slug}`}
                  when={tr("webinar.public.card.on_demand")}
                  language={language(x)}
                  badge={x.registration ? tr("webinar.portal.list.registered") : null}
                  details={x.registration ? availability(x) : []}
                  action={x.registration ? tr("webinar.portal.list.watch") : tr("webinar.portal.list.details")}
                />
                {x.registration ? null : <div className="mt-2">{registerForm(x.webinar.id, x.webinar.slug)}</div>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {discover.length ? (
        <section aria-labelledby="my-webinars-discover" className="space-y-3">
          <h2 id="my-webinars-discover" className="text-xl font-semibold">
            {tr("webinar.portal.list.discover")}
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2">
            {discover.map((w) => (
              <li key={w.id}>
                <WebinarCard
                  title={titleIn(w.title as Record<string, string>, locale)}
                  href={`/${URL_SEGMENT[locale]}/webinars/${w.slug}`}
                  when={tr("webinar.public.landing.date", { date: webinarDate(w.startsAt, locale) })}
                  language={tr("webinar.public.card.language", { language: spokenLanguageName(w.spokenLocale, locale) })}
                  action={tr("webinar.portal.list.details")}
                />
                <div className="mt-2">{registerForm(w.id, w.slug)}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

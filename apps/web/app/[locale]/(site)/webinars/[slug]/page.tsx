import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { LOCALES, URL_SEGMENT, localeFromSegment } from "@beam/core/i18n";
import { LocaleUnavailable } from "@beam/ui";
import { spokenLanguageName, titleIn, webinarDate } from "@beam/email/templates/webinar";
import { getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { getWebinarBySlug, publicSlugById, registrationFormLabels } from "@/modules/webinar/queries";
import { WEBINAR_CONSENT_WORDING_VERSION } from "@/modules/webinar/server/registration";
import { RegistrationForm } from "@/modules/webinar/ui/registration-form";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale: seg, slug } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) return {};
  const found = await getWebinarBySlug(await getAppDb(), slug, locale);
  if (!found) return {};
  return { title: titleIn(found.webinar.title as Record<string, string>, locale) };
}

/**
 * `/[locale]/webinars/[slug]` (webinar spec 5.3, behind `ff_webinar_portal`): the landing page
 * with title, description, date in Brussels time, the spoken language, the presenters' display
 * names and the registration form (unticked consent boxes, privacy link under the button). A
 * webinar id instead of the slug answers 308 to the slug URL. States: not in this locale (locale
 * switch), cancelled (notice), ended without an open replay ("This webinar has ended"), open for
 * the replay after the end.
 */
export default async function WebinarLandingPage({ params }: Props) {
  const { locale: seg, slug } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  if (!(await flag("ff_webinar_portal", { kind: "public" }))) notFound();
  const db = await getAppDb();
  const found = await getWebinarBySlug(db, slug, locale);
  if (!found) {
    const real = await publicSlugById(db, slug);
    if (real) permanentRedirect(`/${seg}/webinars/${real}` as Route);
    notFound();
  }
  const { webinar: w, presenters, state } = found;
  const tr = translator(locale);
  const title = titleIn(w.title as Record<string, string>, locale);
  const back = (
    <p>
      <Link href={`/${seg}/webinars` as Route} className="underline underline-offset-2">
        {tr("webinar.public.landing.back")}
      </Link>
    </p>
  );

  if (state === "wrong_locale") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <LocaleUnavailable
          title={tr("webinar.public.landing.not_available_title")}
          description={tr("webinar.public.landing.not_available_body")}
          alternatives={LOCALES.filter((l) => w.locales.includes(l)).map((l) => ({
            locale: l,
            label: spokenLanguageName(l, l),
            href: `/${URL_SEGMENT[l]}/webinars/${w.slug}`,
          }))}
        />
      </div>
    );
  }

  const description = (w.description as Record<string, string>)[locale] ?? "";
  return (
    <article className="mx-auto max-w-3xl space-y-6 px-4 py-10" aria-labelledby="webinar-title">
      <header className="space-y-2">
        <h1 id="webinar-title" className="text-3xl font-semibold">
          {title}
        </h1>
        <p>{w.startsAt ? tr("webinar.public.landing.date", { date: webinarDate(w.startsAt, locale) }) : tr("webinar.public.landing.on_demand_note")}</p>
        <p className="text-muted-foreground">{tr("webinar.public.landing.in_language", { language: spokenLanguageName(w.spokenLocale, locale) })}</p>
        {w.startsAt ? <p className="text-sm text-muted-foreground">{tr("webinar.public.landing.duration", { minutes: Math.round((w.durationSec ?? w.plannedDurationMinutes * 60) / 60) })}</p> : null}
      </header>
      {description ? (
        <div className="space-y-3">
          {description.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>
      ) : null}
      {presenters.length ? (
        <section aria-labelledby="webinar-presenters" className="space-y-1">
          <h2 id="webinar-presenters" className="text-lg font-semibold">
            {tr("webinar.public.landing.presenters")}
          </h2>
          <ul className="list-inside list-disc">
            {presenters.map((p) => (
              <li key={p.displayName}>{p.displayName}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {state === "cancelled" ? (
        <section role="status" className="space-y-1 rounded-md border border-border p-4">
          <h2 className="text-lg font-semibold">{tr("webinar.public.landing.cancelled_title")}</h2>
          <p>{tr("webinar.public.landing.cancelled_body")}</p>
        </section>
      ) : state === "closed_ended" ? (
        <section role="status" className="space-y-1 rounded-md border border-border p-4">
          <h2 className="text-lg font-semibold">{tr("webinar.public.landing.ended_title")}</h2>
          <p>{tr("webinar.public.landing.ended_body")}</p>
        </section>
      ) : (
        <section aria-labelledby="webinar-register" className="space-y-3 rounded-lg border border-border p-4">
          <h2 id="webinar-register" className="text-xl font-semibold">
            {state === "replay" ? tr("webinar.public.landing.replay_title") : tr("webinar.public.landing.register_title")}
          </h2>
          {state === "replay" ? <p className="text-sm">{tr("webinar.public.landing.replay_note")}</p> : null}
          <RegistrationForm
            variant="site"
            webinarId={w.id}
            slug={w.slug}
            locale={locale}
            wordingVersion={WEBINAR_CONSENT_WORDING_VERSION}
            privacyHref={`/${seg}/privacy`}
            labels={registrationFormLabels(tr)}
          />
          <p className="flex flex-wrap gap-4 text-sm">
            {w.startsAt && state === "register" ? (
              <a href={`/api/public/webinars/${w.slug}/ics?locale=${locale}`} className="underline underline-offset-2">
                {tr("webinar.public.landing.add_calendar")}
              </a>
            ) : null}
            <Link href={`/${seg}/webinars/${w.slug}/join` as Route} className="underline underline-offset-2">
              {tr("webinar.public.landing.lost_link")}
            </Link>
          </p>
        </section>
      )}
      {back}
    </article>
  );
}

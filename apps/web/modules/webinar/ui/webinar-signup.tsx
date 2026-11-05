/**
 * `WebinarSignup` (webinar spec 4.7): the server component site renders in its `webinar_signup`
 * page block (`{ webinarId, locale }`). It shows the webinar's title, date in Brussels time and
 * spoken language with the public registration form, or a short notice when the webinar is not
 * open in this language. Nothing renders while `ff_webinar_portal` is off or when the webinar is
 * not public (draft, archived, unknown id), so a page block never breaks the page.
 */
import { URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { spokenLanguageName, titleIn, webinarDate } from "@beam/email/templates/webinar";
import { webinars } from "@beam/db/schema";
import { eq, getAppDb } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { translator } from "@/lib/i18n";
import { getWebinarBySlug, registrationFormLabels } from "../queries";
import { registrationConsentWordings, WEBINAR_CONSENT_WORDING_VERSION } from "../server/registration";
import { RegistrationForm } from "./registration-form";

export async function WebinarSignup({ webinarId, locale }: { webinarId: string; locale: Locale }) {
  if (!(await flag("ff_webinar_portal", { kind: "public" }))) return null;
  const db = await getAppDb();
  const [row] = /^[0-9a-f-]{36}$/i.test(webinarId) ? await db.select({ slug: webinars.slug }).from(webinars).where(eq(webinars.id, webinarId)) : [];
  if (!row) return null;
  const found = await getWebinarBySlug(db, row.slug, locale);
  if (!found) return null;
  const { webinar: w, state } = found;
  const tr = translator(locale);
  const seg = URL_SEGMENT[locale];
  const title = titleIn(w.title, locale);
  const when = w.startsAt ? tr("webinar.public.landing.date", { date: webinarDate(w.startsAt, locale) }) : tr("webinar.public.card.on_demand");
  const open = state === "register" || state === "replay";
  return (
    <section aria-labelledby={`webinar-signup-${w.id}`} className="space-y-3 rounded-lg border border-border p-4">
      <h2 id={`webinar-signup-${w.id}`} className="text-xl font-semibold">
        {title}
      </h2>
      <p className="text-sm">{when}</p>
      <p className="text-sm text-muted-foreground">{tr("webinar.public.landing.in_language", { language: spokenLanguageName(w.spokenLocale, locale) })}</p>
      {open ? (
        <RegistrationForm
          variant="site"
          webinarId={w.id}
          slug={w.slug}
          locale={locale}
          wordingVersion={WEBINAR_CONSENT_WORDING_VERSION}
          consentWordings={await registrationConsentWordings(db, locale)}
          privacyHref={`/${seg}/privacy`}
          labels={registrationFormLabels(tr)}
        />
      ) : (
        <p className="text-sm">
          <a href={`/${seg}/webinars/${w.slug}`} className="underline underline-offset-2">
            {tr("webinar.public.list.open")}
          </a>
        </p>
      )}
    </section>
  );
}

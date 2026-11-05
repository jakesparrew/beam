import type { Metadata, Route } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { URL_SEGMENT, localeFromSegment } from "@beam/core/i18n";
import { spokenLanguageName, titleIn, webinarDate } from "@beam/email/templates/webinar";
import { requireCustomer } from "@/lib/auth";
import { webinars } from "@beam/db/schema";
import { eq, getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { getCurrentConsents } from "@/modules/crm/api";
import { findPublicWebinarBySlug, registrationConsentWordings, WEBINAR_CONSENT_WORDING_VERSION } from "@/modules/webinar/server/registration";
import { registrationFormLabels } from "@/modules/webinar/queries";
import { playerLabels, viewerFromPerson } from "@/modules/webinar/server/viewer";
import { RegistrationForm } from "@/modules/webinar/ui/registration-form";
import { WebinarPlayer } from "@/modules/webinar/ui/webinar-player";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

type Props = { params: Promise<{ locale: string; id: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `/[locale]/account/webinars/[id]` (webinar spec 5.2, rule 20): the portal player for a signed-in
 * customer, without a token (the session cookie identifies the viewer). Not registered: the
 * register card (one click, consent boxes shown once). The player shows `not_started` (countdown),
 * `expired`, `limit_reached`, `blocked` and `cancelled` with a contact link.
 *
 * The page checks only the registration and the webinar, not `ff_webinar_portal` (edge case 27:
 * a running webinar keeps working when the flag is switched off; the portal list stays hidden).
 */
export default async function PortalWebinarPage({ params }: Props) {
  const { locale: seg, id } = await params;
  const locale = localeFromSegment(seg);
  if (!locale || !UUID.test(id)) notFound();
  const actor = await requireCustomer(locale);
  const tr = translator(locale);
  const db = await getAppDb();
  const found = await viewerFromPerson(db, actor.personId, id);
  const back = (
    <p>
      <Link href={`/${seg}/account/webinars` as Route} className="text-sm underline underline-offset-2">
        {tr("webinar.player.back")}
      </Link>
    </p>
  );

  if ("error" in found) {
    const [row] = await db.select({ slug: webinars.slug }).from(webinars).where(eq(webinars.id, id));
    const open = row ? await findPublicWebinarBySlug(db, row.slug) : null;
    if (!open) notFound();
    const consents = await getCurrentConsents(db, actor.personId).catch(() => null);
    return (
      <section aria-labelledby="webinar-register-title" className="space-y-4">
        {back}
        <h1 id="webinar-register-title" className="text-2xl font-semibold">
          {titleIn(open.title, locale)}
        </h1>
        <h2 className="text-lg font-semibold">{tr("webinar.player.register_title")}</h2>
        <p>{tr("webinar.player.register_body")}</p>
        <RegistrationForm
          variant="portal"
          webinarId={open.id}
          slug={open.slug}
          locale={locale}
          wordingVersion={WEBINAR_CONSENT_WORDING_VERSION}
          consentWordings={await registrationConsentWordings(await getAppDb(), locale)}
          privacyHref={`/${URL_SEGMENT[locale]}/privacy`}
          labels={registrationFormLabels(tr)}
          showConsents={!consents || consents.events === null || consents.newsletter === null}
        />
      </section>
    );
  }

  const { webinar: w } = found;
  const nonce = (await headers()).get("x-nonce");
  return (
    <section aria-labelledby="webinar-player-title" className="space-y-4">
      {back}
      <h1 id="webinar-player-title" className="text-2xl font-semibold">
        {titleIn(w.title, locale)}
      </h1>
      <p className="text-sm text-muted-foreground">
        {w.startsAt ? `${tr("webinar.public.landing.date", { date: webinarDate(w.startsAt, locale) })} · ` : null}
        {tr("webinar.public.landing.in_language", { language: spokenLanguageName(w.spokenLocale, locale) })}
      </p>
      <WebinarPlayer
        webinarId={w.id}
        spokenLocale={w.spokenLocale}
        nonce={nonce}
        labels={playerLabels(locale)}
        privacyHref={`/${URL_SEGMENT[locale]}/privacy`}
        contactHref={`/${URL_SEGMENT[locale]}/contact`}
      />
    </section>
  );
}

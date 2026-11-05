import type { Metadata, Route } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { URL_SEGMENT, localeFromSegment } from "@beam/core/i18n";
import { verifyAccessToken } from "@beam/core/webinar";
import { persons, webinarRegistrations, webinars } from "@beam/db/schema";
import { spokenLanguageName, titleIn, webinarAccessKey, webinarDate } from "@beam/email/templates/webinar";
import { eq, getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { playerLabels, viewerFromToken } from "@/modules/webinar/server/viewer";
import { WebinarPlayer } from "@/modules/webinar/ui/webinar-player";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; token: string }> };

/**
 * The token page sends no referrer (the access token is in the URL; it must never reach YouTube or a
 * CTA target in a `Referer` header) and is never indexed.
 */
export const metadata: Metadata = { referrer: "no-referrer", robots: { index: false, follow: false } };

/** The slug of a token whose MAC is valid but whose link was revoked (for the join page link). */
async function slugOfRevoked(token: string): Promise<string | null> {
  const verified = verifyAccessToken(webinarAccessKey(), token);
  if (!verified) return null;
  const [row] = await (await getAppDb())
    .select({ slug: webinars.slug })
    .from(webinarRegistrations)
    .innerJoin(webinars, eq(webinars.id, webinarRegistrations.webinarId))
    .where(eq(webinarRegistrations.id, verified.registrationId));
  return row?.slug ?? null;
}

/**
 * `/[locale]/w/[token]` (webinar spec 5.3, rules 19 and 20): the personal player. The header shows
 * the registrant's first name with "not you?" (to the landing page, edge case 11); the player is
 * the shared `WebinarPlayer`, which sends the token in the `x-webinar-token` header. An invalid or
 * revoked token shows "This link is no longer valid" with the lost-link page. The token never
 * signs the person into the portal.
 *
 * Not behind `ff_webinar_portal`: the flag hides discovery pages and the portal menu only, so a
 * running webinar keeps working when it is switched off (edge case 27).
 */
export default async function WebinarTokenPage({ params }: Props) {
  const { locale: seg, token: raw } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  let token: string;
  try {
    token = decodeURIComponent(raw);
  } catch {
    notFound();
  }
  const tr = translator(locale);
  const db = await getAppDb();
  const found = await viewerFromToken(db, token);

  if ("error" in found) {
    const slug = await slugOfRevoked(token);
    return (
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-10">
        <h1 className="text-2xl font-semibold">{tr("webinar.public.token.invalid_title")}</h1>
        <p>{tr("webinar.public.token.invalid_body")}</p>
        <p className="flex flex-wrap gap-4">
          {slug ? (
            <Link href={`/${seg}/webinars/${slug}/join` as Route} className="underline underline-offset-2">
              {tr("webinar.public.token.request_link")}
            </Link>
          ) : null}
          <Link href={`/${seg}/webinars` as Route} className="underline underline-offset-2">
            {tr("webinar.public.token.all_webinars")}
          </Link>
        </p>
      </div>
    );
  }

  const { registration: r, webinar: w } = found;
  const [person] = await db.select({ firstName: persons.firstName }).from(persons).where(eq(persons.id, r.personId));
  const nonce = (await headers()).get("x-nonce");
  const title = titleIn(w.title, locale);
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
      <header className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {person?.firstName ? `${tr("webinar.public.token.greeting", { name: person.firstName })} ` : null}
          <Link href={`/${seg}/webinars/${w.slug}` as Route} className="underline underline-offset-2">
            {tr("webinar.public.token.not_you")}
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-muted-foreground">
          {w.startsAt ? `${tr("webinar.public.landing.date", { date: webinarDate(w.startsAt, locale) })} · ` : null}
          {tr("webinar.public.landing.in_language", { language: spokenLanguageName(w.spokenLocale, locale) })}
        </p>
      </header>
      <WebinarPlayer
        webinarId={w.id}
        token={token}
        spokenLocale={w.spokenLocale}
        nonce={nonce}
        labels={playerLabels(locale)}
        privacyHref={`/${URL_SEGMENT[locale]}/privacy`}
        contactHref={`/${URL_SEGMENT[locale]}/contact`}
      />
    </div>
  );
}

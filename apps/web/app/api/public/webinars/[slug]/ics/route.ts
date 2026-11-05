/**
 * `GET /api/public/webinars/[slug]/ics?locale=<l>` (webinar spec 4.4, section 8): the calendar
 * entry of a public live or simulive webinar: title in the requested locale, start and end in UTC
 * (`X-WR-TIMEZONE:Europe/Brussels`) and the landing URL. It never carries a personal access link
 * (the same file the access email attaches). `Cache-Control: public, max-age=300`. An unknown,
 * draft, archived or on-demand webinar is `404`.
 */
import { isLocale, type Locale } from "@beam/core/i18n";
import { buildWebinarIcs, titleIn, webinarLandingUrl } from "@beam/email/templates/webinar";
import { getAppDb } from "@/lib/ctx";
import { endsAtOf } from "@/modules/webinar/server/lifecycle";
import { findPublicWebinarBySlug } from "@/modules/webinar/server/registration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await params;
  const requested = new URL(req.url).searchParams.get("locale");
  const w = await findPublicWebinarBySlug(await getAppDb(), slug);
  const endsAt = w ? endsAtOf(w) : null;
  if (!w || !w.startsAt || !endsAt) {
    return Response.json({ ok: false, error: { code: "not_found", message: "webinar_not_found" } }, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const locale: Locale = isLocale(requested) && w.locales.includes(requested) ? requested : w.spokenLocale;
  const body = buildWebinarIcs({
    webinarId: w.id,
    title: titleIn(w.title as Record<string, string>, locale),
    startsAt: w.startsAt,
    endsAt,
    url: webinarLandingUrl(w.slug, locale),
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${w.slug}.ics"`,
      "cache-control": "public, max-age=300",
    },
  });
}

/**
 * `GET /api/webinar/cta/[ctaId]?r=<registration_id>&m=<mode>&s=<sig>` (webinar spec 4.4, rule 36,
 * edge case 26): a CTA click. The signature only records the click; it grants no viewing access,
 * so the access token never appears in a redirect URL.
 *
 * - `302` to the CTA URL with `utm_source=beam-webinar&utm_medium=<mode>&utm_campaign=<slug>&
 *   utm_content=<cta_key>` added where absent. A bad or missing signature still redirects but
 *   records nothing; a valid one writes `cta_clicked` and, the first time per registration, CTA
 *   and mode, `webinar.cta_clicked`.
 * - `404` for an unknown CTA (there is nowhere to send the viewer).
 *
 * `Referrer-Policy: no-referrer`; falls under the 60-per-minute per-IP rule (a limited click is
 * still redirected, unrecorded). The log line holds `{ route, ms, status }` only.
 */
import { webinarCtas, webinars } from "@beam/db/schema";
import { CtaClickQuery } from "@beam/core/webinar";
import { eq, getAppDb } from "@/lib/ctx";
import { logger, reportError } from "@/lib/logger";
import { limitApiRequest } from "@/lib/rate-limit";
import { ctaRedirectUrl, recordCtaClick } from "@/modules/webinar/server/interactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

const redirect = (url: string) => new Response(null, { status: 302, headers: { ...HEADERS, location: url } });

export async function GET(req: Request, { params }: { params: Promise<{ ctaId: string }> }): Promise<Response> {
  const started = Date.now();
  const log = (status: number) => logger.info({ route: "webinar.cta", ms: Date.now() - started, status }, "webinar.cta");
  const { ctaId } = await params;
  if (!UUID.test(ctaId)) {
    log(404);
    return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
  }
  try {
    const db = await getAppDb();
    const [found] = await db
      .select({ url: webinarCtas.url, key: webinarCtas.key, slug: webinars.slug })
      .from(webinarCtas)
      .innerJoin(webinars, eq(webinars.id, webinarCtas.webinarId))
      .where(eq(webinarCtas.id, ctaId));
    if (!found) {
      log(404);
      return Response.json({ error: "not_found" }, { status: 404, headers: HEADERS });
    }
    const url = new URL(req.url);
    const query = CtaClickQuery.safeParse({ r: url.searchParams.get("r") ?? undefined, m: url.searchParams.get("m") ?? undefined, s: url.searchParams.get("s") ?? undefined });
    const unrecorded = () => ctaRedirectUrl(found.url, { mode: query.success ? query.data.m : "live", slug: found.slug, ctaKey: found.key });
    if (!query.success) {
      log(302);
      return redirect(unrecorded());
    }
    const limited = await limitApiRequest(db, { pathname: url.pathname, ip: clientIp(req) });
    if (limited) {
      log(302);
      return redirect(unrecorded());
    }
    const out = await db.transaction((tx) => recordCtaClick(tx, { registrationId: query.data.r, ctaId, mode: query.data.m, sig: query.data.s }));
    log(302);
    return redirect(out.redirectUrl);
  } catch (e) {
    reportError(e, { tags: { module: "webinar", route: "cta" } });
    log(500);
    return Response.json({ error: "internal" }, { status: 500, headers: HEADERS });
  }
}

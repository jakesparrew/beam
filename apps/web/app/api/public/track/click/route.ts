/**
 * The click redirect (email spec rule 50, edge case 24): `GET /api/public/track/click?t=&l=`
 * records the click and answers 302 to `links[l]` of that message only; a forged token or an
 * index out of range redirects to the BEAM home page of the locale (no open redirect).
 */
import { getAppDb } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { homeUrl, recordClick } from "@/modules/email/server/tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  let location = homeUrl(null);
  try {
    ({ location } = await recordClick(await getAppDb(), {
      token: url.searchParams.get("t"),
      index: url.searchParams.get("l"),
      userAgent: req.headers.get("user-agent"),
    }));
  } catch (error) {
    reportError(error, { tags: { route: "email.track.click" } });
  }
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

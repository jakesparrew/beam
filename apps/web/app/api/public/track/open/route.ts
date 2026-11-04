/**
 * The open pixel (email spec rule 50): `GET /api/public/track/open?t=<token>` records the open of
 * a marketing message and always answers the 43-byte transparent GIF with `no-store`, whatever
 * the token (a forged or expired token records nothing).
 */
import { getAppDb } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { recordOpen, TRANSPARENT_GIF } from "@/modules/email/server/tracking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  try {
    await recordOpen(await getAppDb(), { token: url.searchParams.get("t"), userAgent: req.headers.get("user-agent") });
  } catch (error) {
    reportError(error, { tags: { route: "email.track.open" } });
  }
  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers: { "content-type": "image/gif", "content-length": String(TRANSPARENT_GIF.byteLength), "cache-control": "no-store, max-age=0" },
  });
}

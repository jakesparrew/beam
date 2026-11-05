/**
 * `POST /api/webinar/view` (webinar spec 4.4, rules 22, 23, 28, 30, 31): starts one player view.
 * The viewer is the `x-webinar-token` header or the customer session (`resolveViewer`); a token
 * never works for another webinar. Input `{ webinarId }`.
 *
 * - `200 { viewId, mode, videoId, startSec, durationSec, controls, polls, ctas, chatEnabled,
 *   questionsEnabled, ... }`: a view started (the server decided the mode).
 * - `200 { error: 'not_started' | 'ended' | 'expired' | 'limit_reached', startsAt?, countdown? }`:
 *   nothing to watch right now; the player shows the matching message.
 * - `403 { error: 'blocked' | 'cancelled' | 'invalid_token' | 'not_registered' }`, `401
 *   { error: 'unauthorized' }` (rule 21).
 *
 * This route falls under the 60-per-minute per-IP rule (unlike the heartbeat and state routes).
 * The log line holds `{ route, webinarId, ms, status }` only: never the token or personal data.
 */
import { ViewInput } from "@beam/core/webinar";
import { getAppDb } from "@/lib/ctx";
import { logger, reportError } from "@/lib/logger";
import { limitApiRequest } from "@/lib/rate-limit";
import { isViewRefusal, startView } from "@/modules/webinar/server/watch";
import { isViewerError, resolveViewer } from "@/modules/webinar/server/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const json = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE });

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  let webinarId: string | null = null;
  const done = (status: number, body: unknown) => {
    logger.info({ route: "webinar.view", webinarId, ms: Date.now() - started, status }, "webinar.view");
    return json(status, body);
  };
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return done(400, { error: "validation" });
  }
  const parsed = ViewInput.safeParse(raw);
  if (!parsed.success) return done(400, { error: "validation" });
  webinarId = parsed.data.webinarId;

  try {
    const db = await getAppDb();
    const limited = await limitApiRequest(db, { pathname: new URL(req.url).pathname, ip: clientIp(req) });
    if (limited) return limited;
    const viewer = await resolveViewer(req, parsed.data.webinarId);
    if (isViewerError(viewer)) return done(viewer.status, { error: viewer.error });
    const now = new Date();
    const result = await db.transaction((tx) => startView(tx, viewer, now));
    if (isViewRefusal(result)) return done(result.error === "blocked" || result.error === "cancelled" ? 403 : 200, result);
    return done(200, result);
  } catch (e) {
    reportError(e, { tags: { module: "webinar", route: "view" } });
    return done(500, { error: "internal" });
  }
}

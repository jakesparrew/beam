/**
 * `GET /api/webinar/state?webinarId&after=<ISO>` (webinar spec 4.4, rules 21, 34, 37): what the
 * player polls, every 5 s while live and every 30 s otherwise: `{ status, mode, videoId,
 * activePoll, activeCta, chat, hidden, myAnswers, muted, chatEnabled, questionsEnabled,
 * serverTime }`. The shared part is memoised 2 s per webinar per instance (`getLiveState`).
 *
 * - `403 { error: 'blocked' | 'cancelled' | ... }`, `401 { error: 'unauthorized' }` (rule 21).
 * - `429`: over the `webinar_state` bucket of 30 polls per registration per minute (rule 25).
 *
 * Counted per registration, never against the 60-per-minute per-IP rule (a room of viewers behind
 * one venue NAT shares one IP; platform PL-68). The log line holds `{ route, webinarId, ms,
 * status }` only: never the token or personal data.
 */
import { StateQuery } from "@beam/core/webinar";
import { getAppDb } from "@/lib/ctx";
import { logger, reportError } from "@/lib/logger";
import { limitApiRequest } from "@/lib/rate-limit";
import { getLiveState } from "@/modules/webinar/server/interactions";
import { isViewerError, resolveViewer } from "@/modules/webinar/server/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = "/api/webinar/state";
const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const json = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE });

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function GET(req: Request): Promise<Response> {
  const started = Date.now();
  let webinarId: string | null = null;
  const log = (status: number) => logger.info({ route: "webinar.state", webinarId, ms: Date.now() - started, status }, "webinar.state");
  const done = (status: number, body: unknown) => {
    log(status);
    return json(status, body);
  };
  const url = new URL(req.url);
  const parsed = StateQuery.safeParse({ webinarId: url.searchParams.get("webinarId") ?? undefined, after: url.searchParams.get("after") || undefined });
  if (!parsed.success) return done(400, { error: "validation" });
  webinarId = parsed.data.webinarId;

  try {
    const viewer = await resolveViewer(req, parsed.data.webinarId);
    if (isViewerError(viewer)) return done(viewer.status, { error: viewer.error });
    const db = await getAppDb();
    const limited = await limitApiRequest(db, { pathname: PATH, ip: clientIp(req), registrationId: viewer.registration.id });
    if (limited) {
      log(429);
      return limited;
    }
    const after = parsed.data.after && !Number.isNaN(parsed.data.after.getTime()) ? parsed.data.after : null;
    return done(200, await getLiveState(db, viewer.webinar.id, after, viewer));
  } catch (e) {
    reportError(e, { tags: { module: "webinar", route: "state" } });
    return done(500, { error: "internal" });
  }
}

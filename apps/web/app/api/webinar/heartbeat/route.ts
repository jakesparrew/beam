/**
 * `POST /api/webinar/heartbeat` (webinar spec 4.4, rules 21, 24-27, 32): one heartbeat of one
 * view, every 15 s while playing (and on pause, end and page hide). Input `{ webinarId, viewId,
 * mode, fromSec, toSec, state }`.
 *
 * - `200 { ok: true, nextMs: 15000 }`: segment and reached facts written (or nothing, when not
 *   playing); `200 { ok: false, stop: 'expired', nextMs }` when the replay access ended (rule 32).
 * - `403 { ok: false, stop: 'blocked' | 'cancelled' }`: the player stops (rule 21).
 * - `409 { ok: false, stop: 'mode_changed' }`: the client's mode is not the server's; the player
 *   reloads (rule 22, edge case 5).
 * - `429`: sooner than 10 s after the view's previous heartbeat, or over the `webinar_heartbeat`
 *   bucket of 8 per registration per minute (rule 25). Nothing is written.
 *
 * Counted per registration, never against the 60-per-minute per-IP rule (a room of viewers behind
 * one venue NAT shares one IP; platform PL-68). The log line holds `{ route, webinarId, ms,
 * status }` only.
 */
import { HeartbeatInput } from "@beam/core/webinar";
import { getAppDb } from "@/lib/ctx";
import { logger, reportError } from "@/lib/logger";
import { limitApiRequest, rateLimitResponse } from "@/lib/rate-limit";
import { heartbeatStatus, recordHeartbeat } from "@/modules/webinar/server/watch";
import { isViewerError, resolveViewer } from "@/modules/webinar/server/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = "/api/webinar/heartbeat";
const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE });

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  let webinarId: string | null = null;
  const log = (status: number) => logger.info({ route: "webinar.heartbeat", webinarId, ms: Date.now() - started, status }, "webinar.heartbeat");
  const done = (status: number, body: unknown) => {
    log(status);
    return json(status, body);
  };
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return done(400, { ok: false, error: "validation" });
  }
  const parsed = HeartbeatInput.safeParse(raw);
  if (!parsed.success) return done(400, { ok: false, error: "validation" });
  const input = parsed.data;
  webinarId = input.webinarId;

  try {
    const viewer = await resolveViewer(req, input.webinarId);
    if (isViewerError(viewer)) {
      const stop = viewer.error === "blocked" || viewer.error === "cancelled" ? viewer.error : undefined;
      return done(viewer.status, { ok: false, error: viewer.error, ...(stop ? { stop } : {}) });
    }
    const db = await getAppDb();
    const limited = await limitApiRequest(db, { pathname: PATH, ip: clientIp(req), registrationId: viewer.registration.id });
    if (limited) {
      log(429);
      return limited;
    }
    const now = new Date();
    const result = await db.transaction((tx) => recordHeartbeat(tx, viewer, input, now));
    const status = heartbeatStatus(result);
    if (!result.ok && "error" in result) {
      log(429);
      return rateLimitResponse(result.retryAfterSec);
    }
    if (result.ok) return done(status, { ok: true, nextMs: result.nextMs });
    return done(status, { ok: false, stop: result.stop, nextMs: result.nextMs });
  } catch (e) {
    reportError(e, { tags: { module: "webinar", route: "heartbeat" } });
    return done(500, { ok: false, error: "internal" });
  }
}

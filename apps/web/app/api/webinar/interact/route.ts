/**
 * `POST /api/webinar/interact` (webinar spec 4.4, rules 21, 33-37): a viewer's poll answer, chat
 * message, question or "CTA shown". Body: `{ type: 'poll_answer', pollId, optionKeys }` |
 * `{ type: 'chat' | 'question', text }` | `{ type: 'cta_shown', ctaId }`, plus `{ webinarId,
 * viewId, atSec? }`. The server decides the mode; a client position counts only outside live.
 *
 * - `200 { ok: true }` (chat and questions also `id`; `cta_shown` also `recorded`).
 * - `409 { ok: false, error: 'already_answered' }` (edge case 14), `409 { error: 'closed' |
 *   'disabled' }` (poll not open, chat off or not live).
 * - `403 { ok: false, error: 'muted', message: 'webinar.chat.muted' }` for chat and questions of
 *   a muted viewer (rule 21); `403 { error: 'blocked' | 'cancelled' | ... }` from the viewer check.
 * - `429` with `Retry-After`: one message per 3 s and 60 per hour per registration (rule 37), or
 *   the 60-per-minute per-IP rule of this route.
 *
 * The log line holds `{ route, webinarId, ms, status }` only: never the token, text or answers.
 */
import { InteractInput } from "@beam/core/webinar";
import { getAppDb } from "@/lib/ctx";
import { logger, reportError } from "@/lib/logger";
import { limitApiRequest, rateLimitResponse } from "@/lib/rate-limit";
import { answerPoll, postMessage, recordCtaShown } from "@/modules/webinar/server/interactions";
import { isViewerError, resolveViewer } from "@/modules/webinar/server/viewer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PATH = "/api/webinar/interact";
const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const json = (status: number, body: unknown) => Response.json(body, { status, headers: NO_STORE });

/** The catalogue key the composer shows for a muted viewer (rule 21). */
const MUTED_MESSAGE = "webinar.chat.muted";

const MESSAGE_STATUS = { muted: 403, blocked: 403, disabled: 409, closed: 409, invalid: 400, rate_limited: 429 } as const;
const POLL_STATUS = { already_answered: 409, invalid: 400, closed: 409 } as const;

function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim() || "unknown";
}

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  let webinarId: string | null = null;
  const log = (status: number) => logger.info({ route: "webinar.interact", webinarId, ms: Date.now() - started, status }, "webinar.interact");
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
  const parsed = InteractInput.safeParse(raw);
  if (!parsed.success) return done(400, { ok: false, error: "validation" });
  const input = parsed.data;
  webinarId = input.webinarId;

  try {
    const db = await getAppDb();
    const limited = await limitApiRequest(db, { pathname: PATH, ip: clientIp(req) });
    if (limited) {
      log(429);
      return limited;
    }
    const viewer = await resolveViewer(req, input.webinarId);
    if (isViewerError(viewer)) return done(viewer.status, { ok: false, error: viewer.error });
    const now = new Date();

    if (input.type === "poll_answer") {
      const out = await db.transaction((tx) => answerPoll(tx, viewer, { pollId: input.pollId, optionKeys: input.optionKeys, atSec: input.atSec, viewId: input.viewId }, now));
      return out.ok ? done(200, { ok: true }) : done(POLL_STATUS[out.code], { ok: false, error: out.code });
    }
    if (input.type === "cta_shown") {
      const out = await db.transaction((tx) => recordCtaShown(tx, viewer, { ctaId: input.ctaId, atSec: input.atSec, viewId: input.viewId }, now));
      return out.ok ? done(200, { ok: true, recorded: out.recorded }) : done(POLL_STATUS[out.code], { ok: false, error: out.code });
    }
    const out = await db.transaction((tx) => postMessage(tx, viewer, { kind: input.type, text: input.text, atSec: input.atSec, viewId: input.viewId }, now));
    if (out.ok) return done(200, { ok: true, id: out.interactionId });
    if (out.code === "rate_limited") {
      log(429);
      return rateLimitResponse(out.retryAfterSec ?? 3);
    }
    return done(MESSAGE_STATUS[out.code], { ok: false, error: out.code, ...(out.code === "muted" ? { message: MUTED_MESSAGE } : {}) });
  } catch (e) {
    reportError(e, { tags: { module: "webinar", route: "interact" } });
    return done(500, { ok: false, error: "internal" });
  }
}

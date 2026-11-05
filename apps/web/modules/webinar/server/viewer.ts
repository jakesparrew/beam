/**
 * The viewer of the player endpoints (webinar spec 4.4, rules 19-21; webinar-P4).
 *
 * `resolveViewer(req, webinarId)` finds who is watching: the personal access token in the
 * `x-webinar-token` header (rule 19: the MAC is recomputed in constant time, the stored hash and
 * the current `token_version` are checked), else the customer session cookie (rule 20: a
 * logged-in customer reaches the same player without a token). A token never works for another
 * webinar. A `blocked` or `cancelled` registration is a `403` (`webinar.access.blocked` /
 * `webinar.access.cancelled`) on every viewer endpoint (rule 21).
 *
 * The ff_webinar_portal flag is not checked here (edge case 27): a running webinar continues when
 * the flag is switched off; the flag only hides discovery pages and the portal menu.
 *
 * Raw tokens are never stored or logged; errors carry codes only.
 */
import { webinarRegistrations, webinars } from "@beam/db/schema";
import { hashAccessToken, isCurrentToken, verifyAccessToken } from "@beam/core/webinar";
import { webinarAccessKey } from "@beam/email/templates/webinar";
import { SESSION_COOKIE, actorFromSession, loadSession } from "@/lib/auth";
import type { Locale } from "@beam/core/i18n";
import { and, eq, getAppDb, type DbOrTx } from "@/lib/ctx";
import { messageTemplate } from "@/lib/i18n";
import type { WebinarPlayerLabels } from "../ui/webinar-player";
import type { WebinarRow } from "./lifecycle";
import type { RegistrationRow } from "./registration";

/** The header the player sends the personal token in (never a query parameter, never a cookie). */
export const TOKEN_HEADER = "x-webinar-token";

export type Viewer = { registration: RegistrationRow; webinar: WebinarRow; via: "token" | "session" };

export type ViewerErrorCode = "unauthorized" | "invalid_token" | "not_registered" | "not_found" | "blocked" | "cancelled";
export type ViewerError = { error: ViewerErrorCode; status: 401 | 403 | 404; message: string };

/** The catalogue-style messages of the viewer errors (rule 21 names the two access ones). */
export const VIEWER_ERROR_MESSAGES: Record<ViewerErrorCode, string> = {
  unauthorized: "webinar.access.unauthorized",
  invalid_token: "webinar.access.invalid_token",
  not_registered: "webinar.access.not_registered",
  not_found: "webinar.access.not_found",
  blocked: "webinar.access.blocked",
  cancelled: "webinar.access.cancelled",
};

const STATUS: Record<ViewerErrorCode, 401 | 403 | 404> = {
  unauthorized: 401,
  invalid_token: 403,
  not_registered: 403,
  not_found: 404,
  blocked: 403,
  cancelled: 403,
};

export function viewerError(error: ViewerErrorCode): ViewerError {
  return { error, status: STATUS[error], message: VIEWER_ERROR_MESSAGES[error] };
}

export const isViewerError = (v: Viewer | ViewerError): v is ViewerError => "error" in v;

/** Rule 21: `blocked` and `cancelled` registrations get a 403 on every viewer endpoint. */
export function registrationRefusal(r: Pick<RegistrationRow, "status">): ViewerError | null {
  if (r.status === "blocked") return viewerError("blocked");
  if (r.status === "cancelled") return viewerError("cancelled");
  return null;
}

/** One cookie of the request (`null` when absent or undecodable). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) {
      try {
        return decodeURIComponent(part.slice(at + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * The registration and webinar of a personal access token, or why it is not valid (rule 19): a
 * malformed token or a bad MAC is `invalid_token`, a revoked version (`token_version` bumped) or
 * a deleted registration (erased person, edge case 18) is `invalid_token` too. The status of the
 * registration is not judged here; the callers do (`registrationRefusal`).
 */
export async function viewerFromToken(db: DbOrTx, token: string): Promise<{ registration: RegistrationRow; webinar: WebinarRow } | ViewerError> {
  const verified = verifyAccessToken(webinarAccessKey(), token);
  if (!verified) return viewerError("invalid_token");
  const [row] = await db
    .select({ r: webinarRegistrations, w: webinars })
    .from(webinarRegistrations)
    .innerJoin(webinars, eq(webinars.id, webinarRegistrations.webinarId))
    .where(and(eq(webinarRegistrations.id, verified.registrationId), eq(webinarRegistrations.accessTokenHash, hashAccessToken(token))));
  if (!row || !isCurrentToken(verified, row.r, token)) return viewerError("invalid_token");
  return { registration: row.r, webinar: row.w };
}

/** The customer's own registration of a webinar (portal player, rule 20). */
export async function viewerFromPerson(db: DbOrTx, personId: string, webinarId: string): Promise<{ registration: RegistrationRow; webinar: WebinarRow } | ViewerError> {
  const [row] = await db
    .select({ r: webinarRegistrations, w: webinars })
    .from(webinarRegistrations)
    .innerJoin(webinars, eq(webinars.id, webinarRegistrations.webinarId))
    .where(and(eq(webinarRegistrations.webinarId, webinarId), eq(webinarRegistrations.personId, personId)));
  if (!row) return viewerError("not_registered");
  return { registration: row.r, webinar: row.w };
}

/**
 * Who is watching `webinarId` (section 4.4): the `x-webinar-token` header first, else the
 * customer session cookie. Returns the registration, the webinar and how the viewer was
 * recognised, or a typed error. A token of another webinar's registration is `invalid_token`.
 */
export async function resolveViewer(req: Request, webinarId: string): Promise<Viewer | ViewerError> {
  const db = await getAppDb();
  const token = req.headers.get(TOKEN_HEADER)?.trim();
  if (token) {
    const found = await viewerFromToken(db, token);
    if ("error" in found) return found;
    if (found.registration.webinarId !== webinarId) return viewerError("invalid_token");
    return registrationRefusal(found.registration) ?? { ...found, via: "token" };
  }
  const sessionToken = readCookie(req, SESSION_COOKIE);
  if (!sessionToken) return viewerError("unauthorized");
  const actor = actorFromSession(await loadSession(db, sessionToken));
  if (!actor || actor.kind !== "customer") return viewerError("unauthorized");
  const found = await viewerFromPerson(db, actor.personId, webinarId);
  if ("error" in found) return found;
  return registrationRefusal(found.registration) ?? { ...found, via: "session" };
}

// ---------------------------------------------------------------------------------------------
// The player's texts (catalogue keys `webinar.player.*`), built on the server for the client player
// ---------------------------------------------------------------------------------------------

/** `WebinarPlayer` labels in `locale`; placeholders (`{time}`, `{count}`) are left for the client to fill. */
export function playerLabels(locale: Locale): WebinarPlayerLabels {
  const t = (key: string) => messageTemplate(locale, `webinar.player.${key}`);
  return {
    notice: { title: t("notice.title"), body: t("notice.body"), accept: t("notice.accept"), privacyLink: t("notice.privacy_link") },
    loading: t("loading"),
    countdown: t("countdown"),
    waiting: t("waiting"),
    modes: { live: t("mode.live"), replay: t("mode.replay"), on_demand: t("mode.on_demand") },
    nowWatching: t("now_watching"),
    refusals: {
      not_started: t("waiting"),
      ended: t("refusal.ended"),
      expired: t("refusal.expired"),
      limit_reached: t("refusal.limit_reached"),
      blocked: t("refusal.blocked"),
      cancelled: t("refusal.cancelled"),
      unauthorized: t("refusal.unauthorized"),
      invalid_token: t("refusal.invalid_token"),
      not_registered: t("refusal.not_registered"),
      error: t("refusal.error"),
    },
    contact: t("contact"),
    captionsOn: t("captions_on"),
    captionsOff: t("captions_off"),
    play: t("play"),
    pause: t("pause"),
    error: t("error"),
    fallbackLink: t("fallback_link"),
    fallbackNote: t("fallback_note"),
    reloading: t("reloading"),
    simulated: t("simulated"),
    position: t("position"),
    viewsLeft: t("views_left"),
    // webinar-P5: the poll card, CTA, chat and question box (rules 33-38, 44).
    interactions: {
      poll: {
        title: t("poll.title"),
        single: t("poll.single"),
        multiple: t("poll.multiple"),
        submit: t("poll.submit"),
        answered: t("poll.answered"),
        already_answered: t("poll.already_answered"),
        closed: t("poll.closed"),
        error: t("poll.error"),
        announce: t("poll.announce"),
        your_answer: t("poll.your_answer"),
      },
      cta: { announce: t("cta.announce"), new_tab: t("cta.new_tab") },
      chat: {
        title: t("chat.title"),
        label: t("chat.label"),
        send: t("chat.send"),
        hint: t("chat.hint"),
        empty: t("chat.empty"),
        muted: t("chat.muted"),
        too_fast: t("chat.too_fast"),
        error: t("chat.error"),
        you: t("chat.you"),
        anonymous: t("chat.anonymous"),
        count: t("chat.count"),
      },
      question: {
        title: t("question.title"),
        label: t("question.label"),
        send: t("question.send"),
        hint: t("question.hint"),
        sent_live: t("question.sent_live"),
        sent_later: t("question.sent_later"),
        muted: t("question.muted"),
        too_fast: t("question.too_fast"),
        error: t("question.error"),
      },
    },
  };
}

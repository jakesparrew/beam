/**
 * Polls, CTAs, chat, questions, the live state and the host console (webinar spec rules 33-38,
 * 21, edge cases 14-17, 23, 26, scenario 5; webinar-P5).
 *
 * Viewer side (called by `/api/webinar/interact`, `/api/webinar/state` and `/api/webinar/cta/[id]`
 * after `resolveViewer`); every write takes `select ... for no key update` on the registration
 * row first, so two tabs of one registration are serialised (rule 25):
 *
 * - `answerPoll`: one answer per registration per mode (partial unique `uq_poll_answer_once`,
 *   rule 33); a live and a replay answer are two rows with their own modes. Writes interaction
 *   `poll_answer`, event `webinar.poll_answered` (`option_key` null for several keys) and the
 *   poll's tag rules for that mode through `crm.applyTag` (unknown tags are skipped and reported,
 *   edge case 16).
 * - `postMessage`: chat (live only, visible to live viewers) and questions (hosts only; in replay
 *   and on-demand each one creates a task without its text). 1-500 characters, one message per
 *   3 s and 60 per hour per registration; a muted registration gets `muted` (rule 21).
 * - `recordCtaShown`: once per registration, CTA and mode (`uq_cta_shown_once`); no event.
 * - `recordCtaClick`: the signed click of rule 36. A bad signature still redirects but records
 *   nothing; a valid one writes `cta_clicked` on every click and `webinar.cta_clicked` once per
 *   registration, CTA and mode. The redirect adds the UTM parameters that are absent.
 * - `getLiveState`: what the player polls (status, video, the host's live poll and CTA, visible
 *   chat, the viewer's answers, muted). The shared part is memoised 2 s per webinar per instance.
 *
 * Host side (staff actions with `webinars.host`): `launchPoll`, `closePoll`, `showCta`, `hideCta`
 * (rule 34: the launch position becomes `show_at_sec` when empty) and `moderate` (hide, unhide,
 * mark answered, mute, unmute, block, unblock; block also hides every visible chat message of the
 * viewer, edge case 17), plus `getHostConsoleState` for `/admin/webinars/[id]/host`.
 */
import { tags, watchSegments, webinarCtas, webinarInteractions, webinarModerationActions, webinarPolls, webinarRegistrations, webinars } from "@beam/db/schema";
import type { Locale, LocalizedText } from "@beam/core/i18n";
import {
  answerOptionKey,
  deriveCtaKey,
  effectiveDurationSec,
  resolveMode,
  signCtaClick,
  simulivePositionSec,
  tagsForAnswer,
  validatePollAnswer,
  verifyCtaClick,
  type ModerationAction,
  type WatchMode,
  type WebinarMode,
  type WebinarStatus,
} from "@beam/core/webinar";
import { titleIn, webinarAuthSecret } from "@beam/email/templates/webinar";
import { ConflictError, NotFoundError, ValidationError, and, asc, createCtx, desc, eq, gt, inArray, isNotNull, isNull, sql, type Ctx, type DbOrTx, type Tx } from "@/lib/ctx";
import { reportMessage } from "@/lib/logger";
import { rowsOf } from "@/lib/sensitive";
import { applyTag, createTask } from "@/modules/crm/api";
import type { CtaRow, PollRow, WebinarRow } from "./lifecycle";
import type { RegistrationRow } from "./registration";
import type { Viewer } from "./viewer";
import { ctaClickPath } from "./watch";

export { signCtaClick };

/** Rule 37: at most one chat message or question per 3 s and 60 per hour per registration. */
export const MESSAGE_LIMITS = { minSpacingSec: 3, perHour: 60, maxLength: 500 } as const;
/** The shared part of the live state is memoised this long per webinar per instance (section 4.4). */
export const LIVE_STATE_MEMO_MS = 2000;
/** Chat lines the state route and the host console look at (newest first). */
export const CHAT_WINDOW = 200;
/** The state route answers messages from `after - CHAT_OVERLAP_MS` on; the player dedupes by id (commit lag). */
export const CHAT_OVERLAP_MS = 5000;
/** The host console counts a viewer with a segment in the last 30 s (section 5.1). */
export const VIEWER_WINDOW_SEC = 30;
/** The task title of a replay or on-demand question (rule 37); the text is never copied. */
export const QUESTION_TASK_TITLE = "Webinar question from a viewer";

const ref = (registrationId: string) => ({ type: "webinar_registration", id: registrationId });

/** Viewer facts carry the `system` actor: the viewer may be an anonymous token holder. */
function systemCtx(tx: Tx, now: Date): Ctx {
  return createCtx({ tx, actor: { kind: "system", jobId: "" }, now });
}

/** The registration row under `select ... for no key update` (rule 25). */
async function lockRegistration(tx: Tx, registrationId: string): Promise<RegistrationRow> {
  const [r] = await tx.select().from(webinarRegistrations).where(eq(webinarRegistrations.id, registrationId)).for("no key update");
  if (!r) throw new NotFoundError("registration_not_found");
  return r;
}

async function loadWebinar(db: DbOrTx, webinarId: string): Promise<WebinarRow> {
  const [w] = await db.select().from(webinars).where(eq(webinars.id, webinarId));
  if (!w) throw new NotFoundError("webinar_not_found");
  return w;
}

/** The mode the server decides now (rule 22), or null when nothing plays. */
export function currentMode(w: WebinarRow, now: Date): WatchMode | null {
  const resolved = resolveMode(w, now);
  return "mode" in resolved ? resolved.mode : null;
}

/** Whether the host launches items (live webinar in live mode), rather than video positions (rule 34). */
const hostDriven = (w: WebinarRow, mode: WatchMode) => w.mode === "live" && mode === "live";

/** The video position of an interaction: the server clock while live (rule 24), else the client's, clamped. */
export function positionAt(w: WebinarRow, mode: WatchMode, clientAtSec: number | undefined, now: Date): number | null {
  if (mode === "live") {
    if (w.mode === "simulive") return simulivePositionSec(w, now);
    if (!w.liveStartedAt) return null;
    return Math.max(0, Math.floor((now.getTime() - w.liveStartedAt.getTime()) / 1000));
  }
  if (clientAtSec === undefined) return null;
  return Math.max(0, Math.min(Math.floor(clientAtSec), effectiveDurationSec(w)));
}

/** A live, host-launched poll is open between launch and close; elsewhere it needs a `show_at_sec` (rule 34). */
export function pollOpen(w: WebinarRow, poll: Pick<PollRow, "isActive" | "showAtSec" | "liveLaunchedAt" | "liveClosedAt">, mode: WatchMode): boolean {
  if (!poll.isActive) return false;
  if (hostDriven(w, mode)) return poll.liveLaunchedAt !== null && poll.liveClosedAt === null;
  return poll.showAtSec !== null;
}

export function ctaOpen(w: WebinarRow, cta: Pick<CtaRow, "isActive" | "showAtSec" | "liveShownAt" | "liveHiddenAt">, mode: WatchMode): boolean {
  if (!cta.isActive) return false;
  if (hostDriven(w, mode)) return cta.liveShownAt !== null && cta.liveHiddenAt === null;
  return cta.showAtSec !== null;
}

const isRefused = (r: Pick<RegistrationRow, "status">) => r.status !== "registered";

// ---------------------------------------------------------------------------------------------
// Polls (rules 33-35)
// ---------------------------------------------------------------------------------------------

export type AnswerPollInput = { pollId: string; optionKeys: string[]; atSec?: number; viewId?: string | null };
export type AnswerPollResult = { ok: true } | { ok: false; code: "already_answered" | "invalid" | "closed" };

/** The tag keys among `keys` that `tags` knows; unknown ones are reported (edge case 16). */
async function knownTags(tx: Tx, keys: string[], pollId: string): Promise<string[]> {
  if (!keys.length) return [];
  const known = new Set((await tx.select({ key: tags.key }).from(tags).where(inArray(tags.key, keys))).map((t) => t.key));
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length) reportMessage("webinar poll tag rule names an unknown tag", { tags: { module: "webinar", poll_id: pollId }, extra: { unknown } });
  return keys.filter((k) => known.has(k));
}

/**
 * One poll answer of a viewer in the server's mode (rule 33). A second answer in the same mode is
 * `already_answered` and writes nothing (edge case 14); the tags and the event are written once.
 */
export async function answerPoll(tx: Tx, viewer: Viewer, input: AnswerPollInput, now: Date = new Date()): Promise<AnswerPollResult> {
  const r = await lockRegistration(tx, viewer.registration.id);
  if (isRefused(r)) return { ok: false, code: "closed" };
  const w = await loadWebinar(tx, r.webinarId);
  const mode = currentMode(w, now);
  const [poll] = await tx.select().from(webinarPolls).where(and(eq(webinarPolls.id, input.pollId), eq(webinarPolls.webinarId, w.id)));
  if (!poll) return { ok: false, code: "invalid" };
  if (!mode || !pollOpen(w, poll, mode)) return { ok: false, code: "closed" };
  const checked = validatePollAnswer(poll, input.optionKeys);
  if (!checked.ok) return { ok: false, code: "invalid" };

  const [row] = await tx
    .insert(webinarInteractions)
    .values({
      registrationId: r.id,
      webinarId: w.id,
      mode,
      kind: "poll_answer",
      pollId: poll.id,
      viewId: input.viewId ?? null,
      payload: { option_keys: checked.optionKeys },
      atSec: positionAt(w, mode, input.atSec, now),
      occurredAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: webinarInteractions.id });
  if (!row) return { ok: false, code: "already_answered" };

  const ctx = systemCtx(tx, now);
  await ctx.recordEvent({
    kind: "webinar.poll_answered",
    personId: r.personId,
    mode,
    ref: ref(r.id),
    occurredAt: now,
    data: { webinar_id: w.id, registration_id: r.id, poll_key: poll.key, option_keys: checked.optionKeys, option_key: answerOptionKey(checked.optionKeys) },
    dedupeKey: `webinar_reg:${r.id}:${mode}:poll:${poll.id}`,
  });
  for (const tagKey of await knownTags(tx, tagsForAnswer(poll, checked.optionKeys, mode), poll.id)) {
    await applyTag(tx, ctx, r.personId, tagKey, "automation");
  }
  invalidateLiveState(w.id);
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Chat and questions (rules 21, 37, 38)
// ---------------------------------------------------------------------------------------------

export type PostMessageInput = { kind: "chat" | "question"; text: string; atSec?: number; viewId?: string | null };
export type PostMessageFailure = "muted" | "blocked" | "disabled" | "closed" | "invalid" | "rate_limited";
export type PostMessageResult = { ok: true; interactionId: string } | { ok: false; code: PostMessageFailure; retryAfterSec?: number };

/** The rate-limit verdict of rule 37 over the registration's earlier messages. */
async function messageLimit(tx: Tx, registrationId: string, now: Date): Promise<{ retryAfterSec: number } | null> {
  const rows = rowsOf<{ last_at: Date | string | null; in_hour: number | string; first_in_hour: Date | string | null }>(
    await tx.execute(sql`select max(occurred_at) as last_at,
        count(*) filter (where occurred_at > ${new Date(now.getTime() - 3600_000)})::int as in_hour,
        min(occurred_at) filter (where occurred_at > ${new Date(now.getTime() - 3600_000)}) as first_in_hour
      from webinar_interactions
      where registration_id = ${registrationId}::uuid and kind in ('chat', 'question')`),
  );
  const row = rows[0];
  if (!row) return null;
  const lastAt = row.last_at ? new Date(row.last_at).getTime() : null;
  if (lastAt !== null && now.getTime() - lastAt < MESSAGE_LIMITS.minSpacingSec * 1000) {
    return { retryAfterSec: Math.max(1, Math.ceil((lastAt + MESSAGE_LIMITS.minSpacingSec * 1000 - now.getTime()) / 1000)) };
  }
  if (Number(row.in_hour) >= MESSAGE_LIMITS.perHour) {
    const first = row.first_in_hour ? new Date(row.first_in_hour).getTime() : now.getTime();
    return { retryAfterSec: Math.max(1, Math.ceil((first + 3600_000 - now.getTime()) / 1000)) };
  }
  return null;
}

/**
 * A chat message or a question (rule 37). Chat exists only in live (and only while
 * `is_chat_enabled`); questions in every mode while `is_questions_enabled`. A muted registration
 * gets `muted`, a blocked or cancelled one `blocked` (rule 21). Every question writes
 * `webinar.question_asked`; outside live it also creates a task for the webinar owner (dedupe on
 * the interaction id, without the text). The first chat message per mode writes
 * `webinar.chat_posted`.
 */
export async function postMessage(tx: Tx, viewer: Viewer, input: PostMessageInput, now: Date = new Date()): Promise<PostMessageResult> {
  const text = input.text.trim();
  if (text.length < 1 || text.length > MESSAGE_LIMITS.maxLength) return { ok: false, code: "invalid" };
  const r = await lockRegistration(tx, viewer.registration.id);
  if (isRefused(r)) return { ok: false, code: "blocked" };
  if (r.mutedAt) return { ok: false, code: "muted" };
  const w = await loadWebinar(tx, r.webinarId);
  const mode = currentMode(w, now);
  if (!mode) return { ok: false, code: "closed" };
  if (input.kind === "chat" && (mode !== "live" || !w.isChatEnabled)) return { ok: false, code: "disabled" };
  if (input.kind === "question" && !w.isQuestionsEnabled) return { ok: false, code: "disabled" };
  const limited = await messageLimit(tx, r.id, now);
  if (limited) return { ok: false, code: "rate_limited", retryAfterSec: limited.retryAfterSec };

  const [row] = await tx
    .insert(webinarInteractions)
    .values({
      registrationId: r.id,
      webinarId: w.id,
      mode,
      kind: input.kind,
      viewId: input.viewId ?? null,
      payload: { text },
      atSec: positionAt(w, mode, input.atSec, now),
      occurredAt: now,
    })
    .returning({ id: webinarInteractions.id });
  const interactionId = row!.id;
  const ctx = systemCtx(tx, now);
  if (input.kind === "question") {
    await ctx.recordEvent({
      kind: "webinar.question_asked",
      personId: r.personId,
      mode,
      ref: ref(r.id),
      occurredAt: now,
      data: { webinar_id: w.id, registration_id: r.id, interaction_id: interactionId },
      dedupeKey: `webinar_question:${interactionId}:asked`,
    });
    if (mode !== "live") {
      await createTask(tx, ctx, {
        title: QUESTION_TASK_TITLE,
        kind: "follow_up",
        source: "system",
        ownerUserId: w.ownerUserId,
        personId: r.personId,
        dueAt: new Date(now.getTime() + 24 * 3600_000),
        ref: { type: "webinar_interaction", id: interactionId },
        dedupeKey: `webinar_question:${interactionId}`,
      });
    }
  } else {
    await ctx.recordEvent({
      kind: "webinar.chat_posted",
      personId: r.personId,
      mode,
      ref: ref(r.id),
      occurredAt: now,
      data: { webinar_id: w.id, registration_id: r.id },
      dedupeKey: `webinar_reg:${r.id}:${mode}:chat_posted`,
    });
  }
  invalidateLiveState(w.id);
  return { ok: true, interactionId };
}

// ---------------------------------------------------------------------------------------------
// CTAs (rule 36, edge case 26)
// ---------------------------------------------------------------------------------------------

export type CtaShownResult = { ok: true; recorded: boolean } | { ok: false; code: "invalid" | "closed" };

/** `cta_shown` once per registration, CTA and mode (no timeline event). */
export async function recordCtaShown(tx: Tx, viewer: Viewer, input: { ctaId: string; atSec?: number; viewId?: string | null }, now: Date = new Date()): Promise<CtaShownResult> {
  const r = await lockRegistration(tx, viewer.registration.id);
  if (isRefused(r)) return { ok: false, code: "closed" };
  const w = await loadWebinar(tx, r.webinarId);
  const mode = currentMode(w, now);
  const [cta] = await tx.select().from(webinarCtas).where(and(eq(webinarCtas.id, input.ctaId), eq(webinarCtas.webinarId, w.id)));
  if (!cta) return { ok: false, code: "invalid" };
  if (!mode || !ctaOpen(w, cta, mode)) return { ok: false, code: "closed" };
  const inserted = await tx
    .insert(webinarInteractions)
    .values({ registrationId: r.id, webinarId: w.id, mode, kind: "cta_shown", ctaId: cta.id, viewId: input.viewId ?? null, atSec: positionAt(w, mode, input.atSec, now), occurredAt: now })
    .onConflictDoNothing()
    .returning({ id: webinarInteractions.id });
  return { ok: true, recorded: inserted.length > 0 };
}

/** The CTA key of rule 36 (`k_cta`). */
export const ctaKey = (): Uint8Array => deriveCtaKey(webinarAuthSecret());

/** The CTA URL with `utm_source`, `utm_medium`, `utm_campaign` and `utm_content` added when absent (rule 36). */
export function ctaRedirectUrl(url: string, input: { mode: WatchMode; slug: string; ctaKey: string }): string {
  const target = new URL(url);
  const add: Record<string, string> = { utm_source: "beam-webinar", utm_medium: input.mode, utm_campaign: input.slug, utm_content: input.ctaKey };
  for (const [k, v] of Object.entries(add)) if (!target.searchParams.has(k)) target.searchParams.set(k, v);
  return target.toString();
}

export type CtaClickInput = { registrationId: string; ctaId: string; mode: WatchMode; sig: string; atSec?: number };

/**
 * A signed CTA click (rule 36). Returns the redirect URL for every known CTA; `recorded` is
 * false for a bad signature, a registration of another webinar, or one that is not
 * `registered`. A valid click writes `cta_clicked` every time and `webinar.cta_clicked` once per
 * registration, CTA and mode. The signature grants no viewing access.
 */
export async function recordCtaClick(tx: Tx, input: CtaClickInput, now: Date = new Date()): Promise<{ redirectUrl: string; recorded: boolean }> {
  const [found] = await tx
    .select({ cta: webinarCtas, slug: webinars.slug, webinar: webinars })
    .from(webinarCtas)
    .innerJoin(webinars, eq(webinars.id, webinarCtas.webinarId))
    .where(eq(webinarCtas.id, input.ctaId));
  if (!found) throw new NotFoundError("cta_not_found");
  const { cta, webinar: w } = found;
  const redirectUrl = ctaRedirectUrl(cta.url, { mode: input.mode, slug: w.slug, ctaKey: cta.key });
  if (!verifyCtaClick(ctaKey(), input.registrationId, input.ctaId, input.mode, input.sig)) return { redirectUrl, recorded: false };
  const [exists] = await tx.select({ id: webinarRegistrations.id }).from(webinarRegistrations).where(eq(webinarRegistrations.id, input.registrationId));
  if (!exists) return { redirectUrl, recorded: false };
  const r = await lockRegistration(tx, input.registrationId);
  if (r.webinarId !== w.id || isRefused(r)) return { redirectUrl, recorded: false };

  await tx.insert(webinarInteractions).values({
    registrationId: r.id,
    webinarId: w.id,
    mode: input.mode,
    kind: "cta_clicked",
    ctaId: cta.id,
    payload: { url: cta.url },
    atSec: input.atSec === undefined ? positionAt(w, input.mode, undefined, now) : Math.max(0, Math.floor(input.atSec)),
    occurredAt: now,
  });
  await systemCtx(tx, now).recordEvent({
    kind: "webinar.cta_clicked",
    personId: r.personId,
    mode: input.mode,
    ref: ref(r.id),
    occurredAt: now,
    data: { webinar_id: w.id, registration_id: r.id, cta_key: cta.key, url: cta.url },
    dedupeKey: `webinar_reg:${r.id}:${input.mode}:cta:${cta.id}`,
  });
  return { redirectUrl, recorded: true };
}

// ---------------------------------------------------------------------------------------------
// Messages as shown to viewers and hosts (rules 37, 38)
// ---------------------------------------------------------------------------------------------

/** One chat message or question with its current moderation state. */
export type MessageRow = {
  id: string;
  registrationId: string;
  kind: "chat" | "question";
  mode: WatchMode;
  text: string;
  at: Date;
  atSec: number | null;
  /** First name plus the initial of the last name, read now (rule 38). */
  name: string;
  hidden: boolean;
  answered: boolean;
  muted: boolean;
  blocked: boolean;
};

/** "Anna D." from the person's current names (rule 38); empty when the person has none. */
export function displayName(firstName: string | null, lastName: string | null): string {
  const first = (firstName ?? "").trim();
  const initial = (lastName ?? "").trim().charAt(0);
  return [first, initial ? `${initial.toUpperCase()}.` : ""].filter(Boolean).join(" ");
}

type RawMessage = {
  id: string;
  registration_id: string;
  kind: "chat" | "question";
  mode: WatchMode;
  text: string | null;
  occurred_at: Date | string;
  at_sec: number | null;
  first_name: string | null;
  last_name: string | null;
  muted_at: Date | string | null;
  status: string;
  visibility: string | null;
  answered: boolean | null;
};

/**
 * The newest `limit` messages of a kind (newest first), with the latest hide/unhide row deciding
 * visibility and any `mark_answered` row marking a question answered.
 */
export async function listMessages(db: DbOrTx, webinarId: string, kind: "chat" | "question", opts: { mode?: WatchMode; limit?: number } = {}): Promise<MessageRow[]> {
  const rows = rowsOf<RawMessage>(
    await db.execute(sql`with m as (
        select interaction_id,
               (array_agg(action::text order by created_at desc, id desc) filter (where action in ('hide_message', 'unhide_message')))[1] as visibility,
               bool_or(action = 'mark_answered') as answered
        from webinar_moderation_actions
        where webinar_id = ${webinarId}::uuid and interaction_id is not null
        group by interaction_id)
      select i.id, i.registration_id, i.kind, i.mode, i.payload->>'text' as text, i.occurred_at, i.at_sec,
             p.first_name, p.last_name, r.muted_at, r.status, m.visibility, m.answered
      from webinar_interactions i
      join webinar_registrations r on r.id = i.registration_id
      join persons p on p.id = r.person_id
      left join m on m.interaction_id = i.id
      where i.webinar_id = ${webinarId}::uuid and i.kind = ${kind}::webinar_interactions_kind
        ${opts.mode ? sql`and i.mode = ${opts.mode}::webinar_interactions_mode` : sql``}
      order by i.occurred_at desc, i.id desc
      limit ${opts.limit ?? CHAT_WINDOW}`),
  );
  return rows.map((x) => ({
    id: x.id,
    registrationId: x.registration_id,
    kind: x.kind,
    mode: x.mode,
    text: x.text ?? "",
    at: new Date(x.occurred_at),
    atSec: x.at_sec,
    name: displayName(x.first_name, x.last_name),
    hidden: x.visibility === "hide_message",
    answered: x.answered === true,
    muted: x.muted_at !== null,
    blocked: x.status === "blocked",
  }));
}

// ---------------------------------------------------------------------------------------------
// The live state the player polls (section 4.4 `/api/webinar/state`)
// ---------------------------------------------------------------------------------------------

export type LivePoll = { id: string; key: string; question: string; options: Array<{ key: string; label: string }>; allowMultiple: boolean };
export type LiveCta = { id: string; key: string; label: string; href: string };
export type ChatLine = { id: string; name: string; text: string; at: string; mine: boolean };
export type LiveState = {
  status: WebinarStatus;
  mode: WatchMode | null;
  videoId: string | null;
  activePoll: LivePoll | null;
  activeCta: LiveCta | null;
  /** Visible live chat from `after` on (with a short overlap; the player dedupes by id). */
  chat: ChatLine[];
  /** Ids of recent messages that are hidden now (the player drops them: hidden messages vanish). */
  hidden: string[];
  /** The viewer's poll answers in the current mode, by poll id. */
  myAnswers: Record<string, string[]>;
  muted: boolean;
  chatEnabled: boolean;
  questionsEnabled: boolean;
  /** Set when the registration was blocked or cancelled since the view started (rule 21). */
  stop?: "blocked" | "cancelled";
  serverTime: string;
};

type SharedLive = { at: number; webinar: WebinarRow; poll: PollRow | null; cta: CtaRow | null; chat: MessageRow[] };
const sharedMemo = new Map<string, SharedLive>();

/** Drops the memoised shared state of a webinar (after a write in this instance). */
export function invalidateLiveState(webinarId: string): void {
  sharedMemo.delete(webinarId);
}

async function sharedLive(db: DbOrTx, webinarId: string): Promise<SharedLive> {
  const memo = sharedMemo.get(webinarId);
  if (memo && Date.now() - memo.at < LIVE_STATE_MEMO_MS) return memo;
  const w = await loadWebinar(db, webinarId);
  const [poll] = await db
    .select()
    .from(webinarPolls)
    .where(and(eq(webinarPolls.webinarId, w.id), eq(webinarPolls.isActive, true), isNotNull(webinarPolls.liveLaunchedAt), isNull(webinarPolls.liveClosedAt)))
    .orderBy(desc(webinarPolls.liveLaunchedAt))
    .limit(1);
  const [cta] = await db
    .select()
    .from(webinarCtas)
    .where(and(eq(webinarCtas.webinarId, w.id), eq(webinarCtas.isActive, true), isNotNull(webinarCtas.liveShownAt), isNull(webinarCtas.liveHiddenAt)))
    .orderBy(desc(webinarCtas.liveShownAt))
    .limit(1);
  const chat = w.isChatEnabled && (w.status === "live" || w.mode === "simulive") ? await listMessages(db, w.id, "chat", { mode: "live" }) : [];
  const shared: SharedLive = { at: Date.now(), webinar: w, poll: poll ?? null, cta: cta ?? null, chat };
  sharedMemo.set(webinarId, shared);
  return shared;
}

/** The video a mode plays (the same rule as `startView`): the broadcast while live, else the recording. */
function videoOf(w: WebinarRow, mode: WatchMode | null): string | null {
  if (!mode) return null;
  if (w.mode === "live" && mode === "live") return w.youtubeVideoId;
  return w.recordingVideoId ?? (w.mode === "live" ? w.youtubeVideoId : null);
}

/**
 * What the player polls every 5 s while live and every 30 s otherwise. The shared part (webinar,
 * the host's live poll and CTA, the recent visible chat) is memoised 2 s per webinar; the
 * viewer's part (answers, muted, the signed CTA link) is read per request.
 */
export async function getLiveState(db: DbOrTx, webinarId: string, after: Date | null, viewer: Viewer, now: Date = new Date()): Promise<LiveState> {
  const shared = await sharedLive(db, webinarId);
  const w = shared.webinar;
  const [r] = await db.select().from(webinarRegistrations).where(eq(webinarRegistrations.id, viewer.registration.id));
  const reg = r ?? viewer.registration;
  const locale: Locale = reg.locale;
  const mode = currentMode(w, now);
  const answers = mode
    ? await db
        .select({ pollId: webinarInteractions.pollId, payload: webinarInteractions.payload })
        .from(webinarInteractions)
        .where(and(eq(webinarInteractions.registrationId, reg.id), eq(webinarInteractions.kind, "poll_answer"), eq(webinarInteractions.mode, mode)))
    : [];
  const myAnswers: Record<string, string[]> = {};
  for (const a of answers) if (a.pollId) myAnswers[a.pollId] = Array.isArray(a.payload.option_keys) ? (a.payload.option_keys as string[]) : [];

  const host = mode !== null && hostDriven(w, mode);
  const poll = host && shared.poll ? shared.poll : null;
  const cta = host && shared.cta ? shared.cta : null;
  const chatOn = mode === "live" && w.isChatEnabled;
  const since = after ? after.getTime() - CHAT_OVERLAP_MS : -Infinity;
  const visible = chatOn ? shared.chat.filter((m) => !m.hidden) : [];
  const chat = visible
    .filter((m) => m.at.getTime() > since)
    .slice(0, 100)
    .reverse()
    .map((m) => ({ id: m.id, name: m.name, text: m.text, at: m.at.toISOString(), mine: m.registrationId === reg.id }));
  const stop = reg.status === "blocked" ? "blocked" : reg.status === "cancelled" ? "cancelled" : undefined;
  return {
    status: w.status,
    mode,
    videoId: videoOf(w, mode),
    activePoll: poll
      ? {
          id: poll.id,
          key: poll.key,
          question: titleIn(poll.question, locale),
          options: poll.options.map((o) => ({ key: o.key, label: titleIn(o.label, locale) })),
          allowMultiple: poll.allowMultiple,
        }
      : null,
    activeCta: cta && mode ? { id: cta.id, key: cta.key, label: titleIn(cta.label, locale), href: ctaClickPath(reg.id, cta.id, mode) } : null,
    chat,
    hidden: chatOn ? shared.chat.filter((m) => m.hidden).map((m) => m.id) : [],
    myAnswers,
    muted: reg.mutedAt !== null,
    chatEnabled: chatOn,
    questionsEnabled: mode !== null && w.isQuestionsEnabled,
    ...(stop ? { stop } : {}),
    serverTime: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// Host controls: launch and close polls, show and hide CTAs (rule 34)
// ---------------------------------------------------------------------------------------------

function staffUserId(ctx: Ctx): string {
  if (ctx.actor.kind !== "staff") throw new ValidationError("staff_required");
  return ctx.actor.userId;
}

/** Items are launched only while a live webinar is live (simulive and replays use `show_at_sec`). */
function assertHostLive(w: WebinarRow): void {
  if (w.mode !== "live" || w.status !== "live") throw new ConflictError("not_live");
}

async function lockedWebinar(ctx: Ctx, webinarId: string): Promise<WebinarRow> {
  const [w] = await ctx.tx.select().from(webinars).where(eq(webinars.id, webinarId)).for("update");
  if (!w) throw new NotFoundError("webinar_not_found");
  return w;
}

/**
 * Launches a poll in the live webinar: `live_launched_at = now`, and the launch position becomes
 * `show_at_sec` when it was empty, so the replay shows it at the same moment (rule 34). Another
 * open poll is closed: viewers see one live poll at a time.
 */
export async function launchPoll(ctx: Ctx, input: { pollId: string }): Promise<Record<string, never>> {
  const [poll] = await ctx.tx.select().from(webinarPolls).where(eq(webinarPolls.id, input.pollId));
  if (!poll) throw new NotFoundError("poll_not_found");
  const w = await lockedWebinar(ctx, poll.webinarId);
  assertHostLive(w);
  if (!poll.isActive) throw new ConflictError("inactive");
  await ctx.tx
    .update(webinarPolls)
    .set({ liveClosedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(webinarPolls.webinarId, w.id), isNotNull(webinarPolls.liveLaunchedAt), isNull(webinarPolls.liveClosedAt), sql`${webinarPolls.id} <> ${poll.id}`));
  const showAtSec = poll.showAtSec ?? positionAt(w, "live", undefined, ctx.now) ?? 0;
  await ctx.tx.update(webinarPolls).set({ liveLaunchedAt: ctx.now, liveClosedAt: null, showAtSec, updatedAt: ctx.now }).where(eq(webinarPolls.id, poll.id));
  await ctx.audit({ action: "webinar.poll_launched", entityType: "webinar", entityId: w.id, newValue: { pollId: poll.id, key: poll.key, showAtSec } });
  invalidateLiveState(w.id);
  return {};
}

/** Closes a launched poll (answers after this are `closed`). Closing a closed poll changes nothing. */
export async function closePoll(ctx: Ctx, input: { pollId: string }): Promise<Record<string, never>> {
  const [poll] = await ctx.tx.select().from(webinarPolls).where(eq(webinarPolls.id, input.pollId));
  if (!poll) throw new NotFoundError("poll_not_found");
  const w = await lockedWebinar(ctx, poll.webinarId);
  if (!poll.liveLaunchedAt) throw new ConflictError("not_launched");
  if (poll.liveClosedAt) return {};
  await ctx.tx.update(webinarPolls).set({ liveClosedAt: ctx.now, updatedAt: ctx.now }).where(eq(webinarPolls.id, poll.id));
  await ctx.audit({ action: "webinar.poll_closed", entityType: "webinar", entityId: w.id, newValue: { pollId: poll.id, key: poll.key } });
  invalidateLiveState(w.id);
  return {};
}

/** Shows a CTA in the live webinar (`live_shown_at`; `show_at_sec` when empty, rule 34); another shown CTA is hidden. */
export async function showCta(ctx: Ctx, input: { ctaId: string }): Promise<Record<string, never>> {
  const [cta] = await ctx.tx.select().from(webinarCtas).where(eq(webinarCtas.id, input.ctaId));
  if (!cta) throw new NotFoundError("cta_not_found");
  const w = await lockedWebinar(ctx, cta.webinarId);
  assertHostLive(w);
  if (!cta.isActive) throw new ConflictError("inactive");
  await ctx.tx
    .update(webinarCtas)
    .set({ liveHiddenAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(webinarCtas.webinarId, w.id), isNotNull(webinarCtas.liveShownAt), isNull(webinarCtas.liveHiddenAt), sql`${webinarCtas.id} <> ${cta.id}`));
  const showAtSec = cta.showAtSec ?? positionAt(w, "live", undefined, ctx.now) ?? 0;
  await ctx.tx.update(webinarCtas).set({ liveShownAt: ctx.now, liveHiddenAt: null, showAtSec, updatedAt: ctx.now }).where(eq(webinarCtas.id, cta.id));
  await ctx.audit({ action: "webinar.cta_shown", entityType: "webinar", entityId: w.id, newValue: { ctaId: cta.id, key: cta.key, showAtSec } });
  invalidateLiveState(w.id);
  return {};
}

export async function hideCta(ctx: Ctx, input: { ctaId: string }): Promise<Record<string, never>> {
  const [cta] = await ctx.tx.select().from(webinarCtas).where(eq(webinarCtas.id, input.ctaId));
  if (!cta) throw new NotFoundError("cta_not_found");
  const w = await lockedWebinar(ctx, cta.webinarId);
  if (!cta.liveShownAt) throw new ConflictError("not_shown");
  if (cta.liveHiddenAt) return {};
  await ctx.tx.update(webinarCtas).set({ liveHiddenAt: ctx.now, updatedAt: ctx.now }).where(eq(webinarCtas.id, cta.id));
  await ctx.audit({ action: "webinar.cta_hidden", entityType: "webinar", entityId: w.id, newValue: { ctaId: cta.id, key: cta.key } });
  invalidateLiveState(w.id);
  return {};
}

// ---------------------------------------------------------------------------------------------
// Moderation (section 2.3 registration states, rule 21, edge cases 17 and 23)
// ---------------------------------------------------------------------------------------------

export type ModerateArgs = { webinarId: string; action: ModerationAction; interactionId?: string; registrationId: string };

/**
 * One moderation action. Message actions (`hide_message`, `unhide_message`, `mark_answered`)
 * need a chat message or question of that viewer (`mark_answered` a question). Mute works only
 * on a `registered` registration; block moves `registered -> blocked` (a cancelled registration
 * is `conflict`) and hides every visible chat message of the viewer; unblock moves
 * `blocked -> registered`. A move that changes nothing (muting a muted viewer) writes nothing
 * and returns `changed: false`. Audited as `webinar.moderated`.
 */
export async function moderate(ctx: Ctx, input: ModerateArgs): Promise<{ changed: boolean }> {
  const byUserId = staffUserId(ctx);
  const r = await lockRegistration(ctx.tx, input.registrationId);
  if (r.webinarId !== input.webinarId) throw new NotFoundError("registration_not_found");
  const now = ctx.now;
  const row = (action: ModerationAction, interactionId: string | null = null) => ({ webinarId: r.webinarId, registrationId: r.id, interactionId, action, byUserId, createdAt: now });
  let interactionId: string | null = null;

  if (input.action === "hide_message" || input.action === "unhide_message" || input.action === "mark_answered") {
    if (!input.interactionId) throw new ValidationError("validation", { interactionId: "required" });
    const [msg] = await ctx.tx
      .select({ id: webinarInteractions.id, kind: webinarInteractions.kind })
      .from(webinarInteractions)
      .where(and(eq(webinarInteractions.id, input.interactionId), eq(webinarInteractions.registrationId, r.id)));
    if (!msg || (msg.kind !== "chat" && msg.kind !== "question")) throw new NotFoundError("message_not_found");
    if (input.action === "mark_answered" && msg.kind !== "question") throw new ConflictError("not_a_question");
    interactionId = msg.id;
    await ctx.tx.insert(webinarModerationActions).values(row(input.action, msg.id));
  } else if (input.action === "mute_viewer" || input.action === "unmute_viewer") {
    const mute = input.action === "mute_viewer";
    if (r.status !== "registered") throw new ConflictError("not_registered");
    if (mute === (r.mutedAt !== null)) return { changed: false };
    await ctx.tx
      .update(webinarRegistrations)
      .set(mute ? { mutedAt: now, mutedByUserId: byUserId, updatedAt: now } : { mutedAt: null, mutedByUserId: null, updatedAt: now })
      .where(eq(webinarRegistrations.id, r.id));
    await ctx.tx.insert(webinarModerationActions).values(row(input.action));
  } else if (input.action === "block_viewer") {
    if (r.status === "blocked") return { changed: false };
    if (r.status !== "registered") throw new ConflictError("cancelled");
    await ctx.tx.update(webinarRegistrations).set({ status: "blocked", blockedAt: now, blockedByUserId: byUserId, updatedAt: now }).where(eq(webinarRegistrations.id, r.id));
    // Edge case 17: one `hide_message` row for each of the viewer's chat messages that is visible now.
    await ctx.tx.execute(sql`insert into webinar_moderation_actions (webinar_id, registration_id, interaction_id, action, by_user_id, created_at)
      select i.webinar_id, i.registration_id, i.id, 'hide_message', ${byUserId}::uuid, ${now}
      from webinar_interactions i
      where i.registration_id = ${r.id}::uuid and i.kind = 'chat'
        and coalesce((select m.action::text from webinar_moderation_actions m
                      where m.interaction_id = i.id and m.action in ('hide_message', 'unhide_message')
                      order by m.created_at desc, m.id desc limit 1), 'unhide_message') <> 'hide_message'`);
    await ctx.tx.insert(webinarModerationActions).values(row("block_viewer"));
  } else {
    if (r.status !== "blocked") throw new ConflictError("not_blocked");
    await ctx.tx.update(webinarRegistrations).set({ status: "registered", blockedAt: null, blockedByUserId: null, updatedAt: now }).where(eq(webinarRegistrations.id, r.id));
    await ctx.tx.insert(webinarModerationActions).values(row("unblock_viewer"));
  }
  await ctx.audit({
    action: "webinar.moderated",
    entityType: "webinar",
    entityId: r.webinarId,
    newValue: { action: input.action, registrationId: r.id, interactionId },
  });
  invalidateLiveState(r.webinarId);
  return { changed: true };
}

// ---------------------------------------------------------------------------------------------
// The host console (`/admin/webinars/[id]/host`, section 5.1)
// ---------------------------------------------------------------------------------------------

type ModeCounts = Record<WatchMode, number>;
const zero = (): ModeCounts => ({ live: 0, replay: 0, on_demand: 0 });

export type HostPoll = {
  id: string;
  key: string;
  question: LocalizedText;
  options: Array<{ key: string; label: LocalizedText }>;
  allowMultiple: boolean;
  isActive: boolean;
  showAtSec: number | null;
  launchedAt: Date | null;
  closedAt: Date | null;
  open: boolean;
  /** Answers per option per mode, and respondents per mode. */
  results: Record<string, ModeCounts>;
  respondents: ModeCounts;
};
export type HostCta = {
  id: string;
  key: string;
  label: LocalizedText;
  url: string;
  isActive: boolean;
  showAtSec: number | null;
  shownAt: Date | null;
  hiddenAt: Date | null;
  open: boolean;
  shown: ModeCounts;
  clicked: ModeCounts;
};
export type HostConsoleState = {
  webinar: {
    id: string;
    slug: string;
    title: LocalizedText;
    mode: WebinarMode;
    status: WebinarStatus;
    startsAt: Date | null;
    liveStartedAt: Date | null;
    liveEndedAt: Date | null;
    hostMeetUrl: string | null;
    youtubeVideoId: string | null;
    youtubeLifecycle: string | null;
    broadcastError: string | null;
    isChatEnabled: boolean;
    isQuestionsEnabled: boolean;
  };
  /** YouTube Studio's live control room of the broadcast. */
  studioUrl: string | null;
  /** Rule 42 t15: a live webinar within 15 minutes of its start whose stream is not connected. */
  preflightAlert: boolean;
  /** Registrations with a segment in the last 30 s. */
  viewerCount: number;
  elapsedSec: number | null;
  polls: HostPoll[];
  ctas: HostCta[];
  chat: MessageRow[];
  questions: MessageRow[];
};

/** The YouTube lifecycle states in which the stream counts as connected (rule 42). */
export const CONNECTED_LIFECYCLES = ["ready", "testing", "live"] as const;

export function preflightAlert(w: Pick<WebinarRow, "mode" | "status" | "startsAt" | "youtubeLifecycle">, now: Date): boolean {
  if (w.mode !== "live" || w.status !== "published" || !w.startsAt) return false;
  if (w.startsAt.getTime() - now.getTime() > 15 * 60_000) return false;
  return !(CONNECTED_LIFECYCLES as readonly string[]).includes(w.youtubeLifecycle ?? "");
}

export async function getHostConsoleState(db: DbOrTx, webinarId: string, now: Date = new Date()): Promise<HostConsoleState | null> {
  const [w] = await db.select().from(webinars).where(eq(webinars.id, webinarId));
  if (!w) return null;
  const polls = await db.select().from(webinarPolls).where(eq(webinarPolls.webinarId, w.id)).orderBy(asc(webinarPolls.sortOrder), asc(webinarPolls.createdAt));
  const ctas = await db.select().from(webinarCtas).where(eq(webinarCtas.webinarId, w.id)).orderBy(asc(webinarCtas.sortOrder), asc(webinarCtas.createdAt));

  const answerRows = rowsOf<{ poll_id: string; mode: WatchMode; option_key: string; n: number | string }>(
    await db.execute(sql`select poll_id, mode, jsonb_array_elements_text(payload->'option_keys') as option_key, count(*)::int as n
      from webinar_interactions where webinar_id = ${w.id}::uuid and kind = 'poll_answer' group by 1, 2, 3`),
  );
  const respondentRows = await db
    .select({ pollId: webinarInteractions.pollId, mode: webinarInteractions.mode, n: sql<number>`count(*)::int` })
    .from(webinarInteractions)
    .where(and(eq(webinarInteractions.webinarId, w.id), eq(webinarInteractions.kind, "poll_answer")))
    .groupBy(webinarInteractions.pollId, webinarInteractions.mode);
  const ctaRows = await db
    .select({ ctaId: webinarInteractions.ctaId, kind: webinarInteractions.kind, mode: webinarInteractions.mode, n: sql<number>`count(*)::int` })
    .from(webinarInteractions)
    .where(and(eq(webinarInteractions.webinarId, w.id), inArray(webinarInteractions.kind, ["cta_shown", "cta_clicked"])))
    .groupBy(webinarInteractions.ctaId, webinarInteractions.kind, webinarInteractions.mode);
  const [viewers] = await db
    .select({ n: sql<number>`count(distinct ${watchSegments.registrationId})::int` })
    .from(watchSegments)
    .where(and(eq(watchSegments.webinarId, w.id), gt(watchSegments.recordedAt, new Date(now.getTime() - VIEWER_WINDOW_SEC * 1000))));

  const hostPolls: HostPoll[] = polls.map((p) => {
    const results: Record<string, ModeCounts> = Object.fromEntries(p.options.map((o) => [o.key, zero()]));
    for (const a of answerRows) if (a.poll_id === p.id && results[a.option_key]) results[a.option_key]![a.mode] += Number(a.n);
    const respondents = zero();
    for (const a of respondentRows) if (a.pollId === p.id) respondents[a.mode] += Number(a.n);
    return {
      id: p.id,
      key: p.key,
      question: p.question,
      options: p.options,
      allowMultiple: p.allowMultiple,
      isActive: p.isActive,
      showAtSec: p.showAtSec,
      launchedAt: p.liveLaunchedAt,
      closedAt: p.liveClosedAt,
      open: p.isActive && p.liveLaunchedAt !== null && p.liveClosedAt === null,
      results,
      respondents,
    };
  });
  const hostCtas: HostCta[] = ctas.map((c) => {
    const shown = zero();
    const clicked = zero();
    for (const x of ctaRows) if (x.ctaId === c.id) (x.kind === "cta_shown" ? shown : clicked)[x.mode] += Number(x.n);
    return {
      id: c.id,
      key: c.key,
      label: c.label,
      url: c.url,
      isActive: c.isActive,
      showAtSec: c.showAtSec,
      shownAt: c.liveShownAt,
      hiddenAt: c.liveHiddenAt,
      open: c.isActive && c.liveShownAt !== null && c.liveHiddenAt === null,
      shown,
      clicked,
    };
  });
  const start = w.liveStartedAt ?? (w.mode === "simulive" && w.startsAt && w.startsAt <= now ? w.startsAt : null);
  const end = w.liveEndedAt ?? now;
  return {
    webinar: {
      id: w.id,
      slug: w.slug,
      title: w.title,
      mode: w.mode,
      status: w.status,
      startsAt: w.startsAt,
      liveStartedAt: w.liveStartedAt,
      liveEndedAt: w.liveEndedAt,
      hostMeetUrl: w.hostMeetUrl,
      youtubeVideoId: w.youtubeVideoId,
      youtubeLifecycle: w.youtubeLifecycle,
      broadcastError: w.broadcastError,
      isChatEnabled: w.isChatEnabled,
      isQuestionsEnabled: w.isQuestionsEnabled,
    },
    studioUrl: w.youtubeVideoId ? `https://studio.youtube.com/video/${w.youtubeVideoId}/livestreaming` : null,
    preflightAlert: preflightAlert(w, now),
    viewerCount: Number(viewers?.n ?? 0),
    elapsedSec: start ? Math.max(0, Math.floor((end.getTime() - start.getTime()) / 1000)) : null,
    polls: hostPolls,
    ctas: hostCtas,
    chat: (await listMessages(db, w.id, "chat")).reverse(),
    questions: (await listMessages(db, w.id, "question")).reverse(),
  };
}

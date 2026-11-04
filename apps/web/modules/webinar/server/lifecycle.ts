/**
 * The webinar lifecycle (webinar spec rules 8-13, section 2.3 state table, 4.2; webinar-P2):
 * create, edit, publish, reschedule, cancel, archive, duplicate and force the live state of a
 * webinar, set its videos, and edit its polls, CTAs and presenters. Every function runs in the
 * caller's transaction (`ctx.tx`), takes the webinar row lock first and audits its own action
 * name (the spec's `webinar.created`, `webinar.updated`, ...), so the actions pass `audit: false`.
 *
 * Provider calls never happen here: publishing a live webinar enqueues `webinar.create_broadcast`
 * and `webinar.create_meet_space`; a reschedule enqueues `webinar.update_broadcast` and
 * `webinar.notify_registrants`; a cancel enqueues `webinar.delete_broadcast` and the cancel
 * notices. The job handlers live in `../jobs.ts`.
 */
import { randomUUID } from "node:crypto";
import { jobs, tags, webinarCtas, webinarInteractions, webinarPolls, webinarPresenters, webinarRegistrations, webinars } from "@beam/db/schema";
import { LOCALES, missingLocales, type Locale, type LocalizedText } from "@beam/core/i18n";
import { localDateKey, localMinuteKey, wallClock } from "@beam/core/platform";
import {
  WEBINAR_MODES,
  type CreateWebinarInput,
  type UpdateWebinarInput,
  type UpsertCtaInput,
  type UpsertPollInput,
  type WebinarMode,
  type WebinarStatus,
} from "@beam/core/webinar";
import { ConflictError, NotFoundError, ValidationError, and, asc, desc, eq, inArray, or, sql, type Ctx, type Tx } from "@/lib/ctx";
import { cancelWebinarSession, upsertWebinarSession } from "@/modules/booking/api";
import { findOrCreatePersonByEmail } from "@/modules/crm/api";

export type WebinarRow = typeof webinars.$inferSelect;
export type PollRow = typeof webinarPolls.$inferSelect;
export type CtaRow = typeof webinarCtas.$inferSelect;
export type PresenterRow = typeof webinarPresenters.$inferSelect;
export type NoticeReason = "rescheduled" | "cancelled";

// ---------------------------------------------------------------------------------------------
// The state table (section 2.3): every other move is a `conflict`
// ---------------------------------------------------------------------------------------------

const ALL_MODES: readonly WebinarMode[] = WEBINAR_MODES;

export const WEBINAR_TRANSITIONS: ReadonlyArray<{ from: readonly WebinarStatus[]; to: WebinarStatus; modes: readonly WebinarMode[] }> = [
  { from: ["draft"], to: "published", modes: ALL_MODES },
  { from: ["draft", "published"], to: "cancelled", modes: ALL_MODES },
  { from: ["published"], to: "live", modes: ["live", "simulive"] },
  { from: ["live"], to: "ended", modes: ["live", "simulive"] },
  { from: ["ended", "cancelled"], to: "archived", modes: ALL_MODES },
  { from: ["published"], to: "archived", modes: ["on_demand"] },
];

export function canTransition(from: WebinarStatus, to: WebinarStatus, mode: WebinarMode): boolean {
  return WEBINAR_TRANSITIONS.some((t) => t.to === to && t.from.includes(from) && t.modes.includes(mode));
}

/** Throws `conflict` (`invalid_transition:<from>-><to>`) unless the table has the arrow. */
export function assertTransition(w: Pick<WebinarRow, "status" | "mode">, to: WebinarStatus): void {
  if (!canTransition(w.status, to, w.mode)) throw new ConflictError(`invalid_transition:${w.status}->${to}`);
}

// ---------------------------------------------------------------------------------------------
// Job keys (section 4.5, DM-5: no wall-clock timestamps except the minute buckets of scans)
// ---------------------------------------------------------------------------------------------

/** `YYYY-MM-DDTHH:mm` in Brussels. */
export const minuteKey = (now: Date): string => localMinuteKey(wallClock(now));

export const jobKeys = {
  /** `webinar:<id>:broadcast`, then `:retry:<n>` for a Publish after a dead attempt (edge case 6). */
  broadcast: (id: string, retry = 0) => (retry > 0 ? `webinar:${id}:broadcast:retry:${retry}` : `webinar:${id}:broadcast`),
  broadcastUpdate: (id: string, version: number) => `webinar:${id}:broadcast_update:v${version}`,
  broadcastDelete: (id: string) => `webinar:${id}:broadcast_delete`,
  meet: (id: string) => `webinar:${id}:meet`,
  status: (id: string, now: Date) => `webinar:${id}:status:${minuteKey(now)}`,
  recording: (id: string, now: Date) => `webinar:${id}:recording:${minuteKey(now)}`,
  recordingSet: (id: string, videoId: string) => `webinar:${id}:recording:set:${videoId}`,
  /** A reschedule bumps `version`, so the new time gets its own finalise (webinar-P4 runs it). */
  finalise: (id: string, version: number) => `webinar:${id}:finalise:v${version}`,
  notify: (id: string, reason: NoticeReason, version: number, chunk: number) => `webinar:${id}:notify:${reason}:v${version}:chunk:${chunk}`,
} as const;

/** The idempotency key of one notice email (section 4.5). */
export const noticeEmailKey = (registrationId: string, reason: NoticeReason, version: number) => `webinar_reg:${registrationId}:notice:${reason}:v${version}`;

/** Changes of `starts_at` up to this are not a reschedule worth an email (rule 11, edge case 9). */
export const RESCHEDULE_THRESHOLD_MS = 5 * 60_000;
/** Occurrences one `duplicateWebinar` call may create (rule 12). */
export const MAX_DUPLICATES = 26;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** The webinar row under `select ... for update`; `not_found` when it does not exist. */
export async function lockWebinar(tx: Tx, webinarId: string): Promise<WebinarRow> {
  const [row] = await tx.select().from(webinars).where(eq(webinars.id, webinarId)).for("update");
  if (!row) throw new NotFoundError("webinar_not_found");
  return row;
}

function assertVersion(w: WebinarRow, version: number): void {
  if (w.version !== version) throw new ConflictError("stale_version");
}

function assertEditable(w: WebinarRow): void {
  if (w.status === "cancelled" || w.status === "archived") throw new ConflictError(`webinar_${w.status}`);
}

/** `starts_at + (duration_sec ?? planned duration)`; null on demand. */
export function endsAtOf(w: Pick<WebinarRow, "startsAt" | "durationSec" | "plannedDurationMinutes">): Date | null {
  if (!w.startsAt) return null;
  return new Date(w.startsAt.getTime() + (w.durationSec ?? w.plannedDurationMinutes * 60) * 1000);
}

/** The text in `locale`, else in the spoken language, else any filled locale. */
export function textIn(text: LocalizedText | null | undefined, locale: Locale, fallback?: Locale): string {
  const order = [locale, ...(fallback ? [fallback] : []), ...LOCALES];
  for (const l of order) {
    const v = text?.[l]?.trim();
    if (v) return v;
  }
  return "";
}

const actorUserId = (ctx: Ctx): string | null => (ctx.actor.kind === "staff" || ctx.actor.kind === "customer" ? ctx.actor.userId : null);

function requireStaffUser(ctx: Ctx): string {
  const id = actorUserId(ctx);
  if (!id || ctx.actor.kind !== "staff") throw new ValidationError("staff_actor_required");
  return id;
}

const isUniqueViolation = (error: unknown, constraint?: string): boolean => {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  const code = e?.code ?? e?.cause?.code;
  const name = e?.constraint ?? e?.cause?.constraint ?? "";
  return code === "23505" && (!constraint || name === constraint || String((error as Error)?.message ?? "").includes(constraint));
};

/** `{ field: 'nl-BE,en' }` for every LocalizedText field of a webinar that misses a locale of `locales`. */
function missingFields(entries: Array<[string, LocalizedText | null | undefined]>, locales: readonly Locale[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, text] of entries) {
    const missing = missingLocales(text, locales);
    if (missing.length) out[field] = missing.join(",");
  }
  return out;
}

const pollTextFields = (p: Pick<PollRow, "key" | "question" | "options">): Array<[string, LocalizedText]> => [
  [`poll:${p.key}.question`, p.question],
  ...p.options.map((o): [string, LocalizedText] => [`poll:${p.key}.option:${o.key}`, o.label]),
];

/** Upserts the webinar's calendar session (rule 8) and returns its id. */
async function syncSession(ctx: Ctx, w: WebinarRow): Promise<string> {
  if (!w.startsAt) throw new ValidationError("starts_at_required", { startsAt: "required" });
  const { sessionId } = await upsertWebinarSession(ctx.tx, ctx, {
    webinarId: w.id,
    ...(w.sessionId ? { sessionId: w.sessionId } : {}),
    title: w.title,
    startsAt: w.startsAt,
    endsAt: endsAtOf(w)!,
  });
  return sessionId;
}

/** Registrations that receive notices and lifecycle events. */
async function registeredRows(tx: Tx, webinarId: string) {
  return tx
    .select({
      id: webinarRegistrations.id,
      personId: webinarRegistrations.personId,
      registeredMode: webinarRegistrations.registeredMode,
      personStatus: webinarRegistrations.personStatus,
      source: webinarRegistrations.source,
      utm: webinarRegistrations.utm,
    })
    .from(webinarRegistrations)
    .where(and(eq(webinarRegistrations.webinarId, webinarId), eq(webinarRegistrations.status, "registered")))
    .orderBy(asc(webinarRegistrations.id));
}

const auditWebinar = (ctx: Ctx, action: string, w: Pick<WebinarRow, "id">, values: { oldValue?: unknown; newValue?: unknown } = {}) =>
  ctx.audit({ action, entityType: "webinar", entityId: w.id, ...values });

// ---------------------------------------------------------------------------------------------
// createWebinar / updateWebinar
// ---------------------------------------------------------------------------------------------

export async function createWebinar(ctx: Ctx, input: CreateWebinarInput): Promise<{ webinarId: string }> {
  const userId = requireStaffUser(ctx);
  if (input.mode === "on_demand" && input.startsAt) throw new ValidationError("on_demand_has_no_start", { startsAt: "on_demand_has_no_start" });
  try {
    const [row] = await ctx.tx
      .insert(webinars)
      .values({
        slug: input.slug,
        mode: input.mode,
        title: input.title,
        description: input.description,
        locales: input.locales,
        spokenLocale: input.spokenLocale,
        startsAt: input.mode === "on_demand" ? null : (input.startsAt ?? null),
        plannedDurationMinutes: input.plannedDurationMinutes,
        ownerUserId: input.ownerUserId,
        createdByUserId: userId,
      })
      .returning();
    await auditWebinar(ctx, "webinar.created", row!, { newValue: { slug: input.slug, mode: input.mode, startsAt: row!.startsAt } });
    return { webinarId: row!.id };
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("slug_taken");
    throw error;
  }
}

const UPDATE_FIELDS = [
  "slug",
  "title",
  "description",
  "locales",
  "spokenLocale",
  "startsAt",
  "plannedDurationMinutes",
  "seriesKey",
  "isReplayEnabled",
  "isReplayGated",
  "replayUntilAt",
  "replayViewLimit",
  "onDemandAccessDays",
  "attendedMinSec",
  "conversionWindowDays",
  "isChatEnabled",
  "isQuestionsEnabled",
  "ownerUserId",
  "hostMeetUrl",
] as const satisfies ReadonlyArray<keyof UpdateWebinarInput & keyof WebinarRow>;
type UpdateField = (typeof UPDATE_FIELDS)[number];

const same = (a: unknown, b: unknown): boolean => {
  if (a instanceof Date || b instanceof Date) return (a instanceof Date ? a.getTime() : a) === (b instanceof Date ? b.getTime() : b);
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
};

/**
 * Saves partial settings under the optimistic `version` (edge case 25). On a published webinar a
 * change of title, start or duration updates the calendar session and the broadcast; a start
 * moved by more than 5 minutes is a reschedule: per registrant `webinar.rescheduled`, then a
 * fresh `webinar.registered` (`rescheduled: true`), and one `webinar.rescheduled` email each
 * (rule 11, edge case 9). Any start change clears `finalised_at` and `broadcast_error`.
 */
export async function updateWebinar(ctx: Ctx, input: UpdateWebinarInput): Promise<{ version: number; rescheduled: boolean }> {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  assertVersion(w, input.version);
  assertEditable(w);

  const patch: Partial<Record<UpdateField, unknown>> = {};
  for (const field of UPDATE_FIELDS) {
    const value = input[field];
    if (value !== undefined && !same(value, w[field])) patch[field] = value;
  }
  const changed = Object.keys(patch) as UpdateField[];
  if (!changed.length) return { version: w.version, rescheduled: false };
  const next = { ...w, ...patch } as WebinarRow;

  if (next.mode === "on_demand" && next.startsAt) throw new ValidationError("on_demand_has_no_start", { startsAt: "on_demand_has_no_start" });
  const startsChanged = changed.includes("startsAt");
  if (w.status !== "draft") {
    if (changed.includes("slug")) throw new ConflictError("slug_locked");
    if (next.mode !== "on_demand" && !next.startsAt) throw new ValidationError("starts_at_required", { startsAt: "required" });
    if (startsChanged && w.status !== "published") throw new ConflictError("already_started");
    if (startsChanged && next.startsAt && next.startsAt.getTime() <= ctx.now.getTime()) throw new ValidationError("starts_at_past", { startsAt: "starts_at_past" });
    if (!next.locales.includes(next.spokenLocale)) throw new ValidationError("spoken_locale_not_in_locales", { spokenLocale: "not_in_locales" });
    const missing = missingFields([["title", next.title], ["description", next.description]], next.locales);
    if (Object.keys(missing).length) throw new ValidationError("missing_locales", missing);
  }

  const version = w.version + 1;
  const isReschedule =
    w.status === "published" && startsChanged && !!w.startsAt && !!next.startsAt && Math.abs(next.startsAt.getTime() - w.startsAt.getTime()) > RESCHEDULE_THRESHOLD_MS;
  const set: Partial<typeof webinars.$inferInsert> = { ...(patch as Partial<typeof webinars.$inferInsert>), version, updatedAt: ctx.now };
  if (startsChanged && w.status !== "draft") Object.assign(set, { finalisedAt: null, broadcastError: null });

  const scheduleChanged = changed.some((f) => f === "title" || f === "startsAt" || f === "plannedDurationMinutes");
  if (scheduleChanged && next.mode !== "on_demand" && (w.status === "published" || w.status === "live") && next.sessionId) {
    set.sessionId = await syncSession(ctx, next);
  }
  try {
    await ctx.tx.update(webinars).set(set).where(eq(webinars.id, w.id));
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("slug_taken");
    throw error;
  }

  const broadcastChanged = changed.some((f) => f === "title" || f === "description" || f === "startsAt");
  if (next.mode === "live" && w.youtubeVideoId && broadcastChanged && (w.status === "published" || w.status === "live")) {
    await ctx.enqueue({ kind: "webinar.update_broadcast", payload: { webinarId: w.id, version }, key: jobKeys.broadcastUpdate(w.id, version) });
  }

  if (isReschedule) await writeRescheduleFacts(ctx, { ...next, version }, w.startsAt!);

  const oldValue = Object.fromEntries(changed.map((f) => [f, w[f]]));
  await auditWebinar(ctx, "webinar.updated", w, { oldValue, newValue: patch });
  return { version, rescheduled: isReschedule };
}

/** Edge case 9: per registrant the exit fact, the re-enrolment fact, then one notice email each (job). */
async function writeRescheduleFacts(ctx: Ctx, w: WebinarRow, previousStartsAt: Date): Promise<void> {
  const rows = await registeredRows(ctx.tx, w.id);
  const endsAt = endsAtOf(w);
  for (const r of rows) {
    const ref = { type: "webinar_registration", id: r.id };
    await ctx.recordEvent({
      kind: "webinar.rescheduled",
      personId: r.personId,
      ref,
      data: { webinar_id: w.id, registration_id: r.id, starts_at: w.startsAt!, previous_starts_at: previousStartsAt },
      dedupeKey: `webinar_reg:${r.id}:rescheduled:v${w.version}`,
    });
    await ctx.recordEvent({
      kind: "webinar.registered",
      personId: r.personId,
      ref,
      mode: r.registeredMode,
      data: {
        webinar_id: w.id,
        slug: w.slug,
        title: w.title,
        webinar_mode: w.mode,
        starts_at: w.startsAt,
        ends_at: endsAt,
        registration_id: r.id,
        session: w.sessionId ? { id: w.sessionId, kind: "event" } : null,
        person_status: r.personStatus,
        source: r.source,
        utm: r.utm ?? {},
        rescheduled: true,
      },
      dedupeKey: `webinar_reg:${r.id}:registered:v${w.version}`,
    });
  }
  if (rows.length) {
    await ctx.enqueue({
      kind: "webinar.notify_registrants",
      payload: { webinarId: w.id, reason: "rescheduled", version: w.version, chunk: 0, previousStartsAt: previousStartsAt.toISOString() },
      key: jobKeys.notify(w.id, "rescheduled", w.version, 0),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// publishWebinar (rule 9)
// ---------------------------------------------------------------------------------------------

/** Rule 9 checks: completeness over `locales`, spoken language, future start, a processed video. */
export async function publishProblems(tx: Tx, w: WebinarRow, now: Date): Promise<Record<string, string>> {
  const [polls, ctas] = await Promise.all([
    tx.select().from(webinarPolls).where(and(eq(webinarPolls.webinarId, w.id), eq(webinarPolls.isActive, true))),
    tx.select().from(webinarCtas).where(and(eq(webinarCtas.webinarId, w.id), eq(webinarCtas.isActive, true))),
  ]);
  const problems = missingFields(
    [
      ["title", w.title],
      ["description", w.description],
      ...polls.flatMap(pollTextFields),
      ...ctas.map((c): [string, LocalizedText] => [`cta:${c.key}.label`, c.label]),
    ],
    w.locales,
  );
  if (!w.locales.includes(w.spokenLocale)) problems.spokenLocale = "not_in_locales";
  if (w.mode !== "on_demand") {
    if (!w.startsAt) problems.startsAt = "required";
    else if (w.startsAt.getTime() <= now.getTime()) problems.startsAt = "starts_at_past";
  }
  if (w.mode !== "live") {
    if (!w.recordingVideoId) problems.video = "video_missing";
    else if (!w.durationSec) problems.video = "video_processing";
  }
  return problems;
}

/** The `create_broadcast` jobs of a webinar so far (base key and `:retry:<n>`), newest first. */
async function broadcastJobs(tx: Tx, webinarId: string): Promise<{ count: number; latestStatus: string | null }> {
  const base = jobKeys.broadcast(webinarId);
  const rows = await tx
    .select({ status: jobs.status })
    .from(jobs)
    .where(or(eq(jobs.idempotencyKey, base), sql`${jobs.idempotencyKey} like ${`${base}:retry:%`}`))
    .orderBy(desc(jobs.createdAt));
  return { count: rows.length, latestStatus: rows[0]?.status ?? null };
}

const isLocaleList = (v: string) => v.split(",").every((l) => (LOCALES as readonly string[]).includes(l));

/**
 * Publishes after rule 9. Live: stays `draft` with `publish_requested_at` while
 * `webinar.create_broadcast` runs (that job sets `published` and creates the session); simulive:
 * `published` with its session now; on-demand: `published`, no session. Problems fail with
 * `validation`, message `missing_locales` when only locales are missing, `fields` listing each
 * field (`{ title: 'fr-BE,en', video: 'video_processing', ... }`).
 */
export async function publishWebinar(ctx: Ctx, input: { webinarId: string; version: number }): Promise<{ status: "published" | "publishing" }> {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  assertVersion(w, input.version);
  assertTransition(w, "published");
  const problems = await publishProblems(ctx.tx, w, ctx.now);
  if (Object.keys(problems).length) throw new ValidationError(Object.values(problems).every(isLocaleList) ? "missing_locales" : "not_publishable", problems);

  if (w.mode === "live") {
    const previous = await broadcastJobs(ctx.tx, w.id);
    if (w.publishRequestedAt && (previous.latestStatus === "pending" || previous.latestStatus === "running")) return { status: "publishing" };
    await ctx.tx.update(webinars).set({ publishRequestedAt: ctx.now, broadcastError: null, updatedAt: ctx.now }).where(eq(webinars.id, w.id));
    await ctx.enqueue({ kind: "webinar.create_broadcast", payload: { webinarId: w.id }, key: jobKeys.broadcast(w.id, previous.count) });
    if (!w.meetSpaceName && !w.hostMeetUrl) await ctx.enqueue({ kind: "webinar.create_meet_space", payload: { webinarId: w.id }, key: jobKeys.meet(w.id) });
    await auditWebinar(ctx, "webinar.published", w, { newValue: { status: "publishing", attempt: previous.count } });
    return { status: "publishing" };
  }

  const set: Partial<typeof webinars.$inferInsert> = { status: "published", publishedAt: ctx.now, broadcastError: null, updatedAt: ctx.now };
  if (w.mode === "simulive") set.sessionId = await syncSession(ctx, w);
  await ctx.tx.update(webinars).set(set).where(eq(webinars.id, w.id));
  await auditWebinar(ctx, "webinar.published", w, { newValue: { status: "published" } });
  return { status: "published" };
}

/**
 * The success transaction of `webinar.create_broadcast` (rule 8): stores the broadcast, creates
 * the calendar session and sets `published`. A webinar no longer waiting to publish is left alone.
 */
export async function completeBroadcastPublish(
  ctx: Ctx,
  webinarId: string,
  broadcast: { broadcastId: string; streamId: string | null },
): Promise<{ published: boolean }> {
  const w = await lockWebinar(ctx.tx, webinarId);
  if (w.status !== "draft" || !w.publishRequestedAt) return { published: false };
  const sessionId = await syncSession(ctx, w);
  await ctx.tx
    .update(webinars)
    .set({
      youtubeVideoId: broadcast.broadcastId,
      youtubeStreamId: broadcast.streamId,
      youtubeLifecycle: "created",
      sessionId,
      status: "published",
      publishedAt: ctx.now,
      publishRequestedAt: null,
      broadcastError: null,
      updatedAt: ctx.now,
    })
    .where(eq(webinars.id, w.id));
  return { published: true };
}

// ---------------------------------------------------------------------------------------------
// cancel, archive, force live state
// ---------------------------------------------------------------------------------------------

/**
 * Rule 11: `cancelled`, `webinar.cancelled` per registrant, the calendar session cancelled, the
 * broadcast deleted (job) and, with `notify`, one `webinar.cancelled` email per registrant.
 */
export async function cancelWebinar(ctx: Ctx, input: { webinarId: string; reason: string; notify: boolean }): Promise<{ cancelledRegistrations: number }> {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  assertTransition(w, "cancelled");
  const version = w.version + 1;
  await ctx.tx
    .update(webinars)
    .set({ status: "cancelled", cancelledReason: input.reason, publishRequestedAt: null, version, updatedAt: ctx.now })
    .where(eq(webinars.id, w.id));
  if (w.mode !== "on_demand") await cancelWebinarSession(ctx.tx, ctx, { webinarId: w.id, reason: input.reason });
  if (w.youtubeVideoId) await ctx.enqueue({ kind: "webinar.delete_broadcast", payload: { webinarId: w.id }, key: jobKeys.broadcastDelete(w.id) });

  const rows = await registeredRows(ctx.tx, w.id);
  for (const r of rows) {
    await ctx.recordEvent({
      kind: "webinar.cancelled",
      personId: r.personId,
      ref: { type: "webinar_registration", id: r.id },
      data: { webinar_id: w.id, registration_id: r.id, reason: input.reason },
      dedupeKey: `webinar_reg:${r.id}:cancelled`,
    });
  }
  if (input.notify && rows.length) {
    await ctx.enqueue({
      kind: "webinar.notify_registrants",
      payload: { webinarId: w.id, reason: "cancelled", version, chunk: 0 },
      key: jobKeys.notify(w.id, "cancelled", version, 0),
    });
  }
  await auditWebinar(ctx, "webinar.cancelled", w, { oldValue: { status: w.status }, newValue: { reason: input.reason, notify: input.notify, registrations: rows.length } });
  return { cancelledRegistrations: rows.length };
}

export async function archiveWebinar(ctx: Ctx, input: { webinarId: string }): Promise<Record<string, never>> {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  assertTransition(w, "archived");
  // The `webinars` checks (`ck_webinars_scheduled`, `ck_webinars_live_video`, `ck_webinars_video`)
  // exempt only `draft` and `cancelled`: a webinar cancelled before it was ever published has no
  // session, broadcast or video and stays in the Cancelled tab.
  const neverPublished =
    (w.mode !== "on_demand" && (!w.startsAt || !w.sessionId)) || (w.mode === "live" && !w.youtubeVideoId) || (w.mode !== "live" && !w.recordingVideoId);
  if (neverPublished) throw new ConflictError("never_published");
  await ctx.tx.update(webinars).set({ status: "archived", updatedAt: ctx.now }).where(eq(webinars.id, w.id));
  await auditWebinar(ctx, "webinar.archived", w, { oldValue: { status: w.status } });
  return {};
}

/**
 * One state move of `sync_status` or the host console: `live` stamps `live_started_at`
 * (YouTube's `actualStartTime`, the simulive start or now), `ended` stamps `live_ended_at`.
 */
export async function moveLiveState(ctx: Ctx, w: WebinarRow, to: "live" | "ended", at: Date): Promise<WebinarRow> {
  assertTransition(w, to);
  const set: Partial<typeof webinars.$inferInsert> =
    to === "live" ? { status: "live", liveStartedAt: w.liveStartedAt ?? at, updatedAt: ctx.now } : { status: "ended", liveEndedAt: at, updatedAt: ctx.now };
  const [row] = await ctx.tx.update(webinars).set(set).where(eq(webinars.id, w.id)).returning();
  return row!;
}

/** Rule 10: staff force `live` or `ended` when YouTube's status is unavailable. */
export async function forceLiveState(ctx: Ctx, input: { webinarId: string; to: "live" | "ended" }): Promise<Record<string, never>> {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  await moveLiveState(ctx, w, input.to, ctx.now);
  await auditWebinar(ctx, "webinar.live_forced", w, { oldValue: { status: w.status }, newValue: { status: input.to } });
  return {};
}

// ---------------------------------------------------------------------------------------------
// duplicateWebinar (rule 12)
// ---------------------------------------------------------------------------------------------

const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}(-\d+)?$/;

/** `<slug>-<yyyy-mm-dd>` (Brussels date), the base cut so the result stays within 80 characters. */
export function occurrenceSlug(slug: string, startsAt: Date, n = 1): string {
  const suffix = `-${localDateKey(wallClock(startsAt))}${n > 1 ? `-${n}` : ""}`;
  const base = slug.replace(DATE_SUFFIX, "").slice(0, 80 - suffix.length).replace(/-+$/, "");
  return `${base}${suffix}`;
}

const seriesKeyFrom = (slug: string): string => {
  const key = slug.replace(DATE_SUFFIX, "").slice(0, 60).replace(/-+$/, "");
  return key.length >= 3 ? key : `${key}-series`;
};

/**
 * Copies title, description, locales, mode, settings, the simulive video, active polls, CTAs and
 * presenters into new `draft` occurrences with the series key (the source joins the series when
 * it had none). Live state, broadcast, Meet space and registrations are not copied.
 */
export async function duplicateWebinar(ctx: Ctx, input: { webinarId: string; startsAt: Date[]; seriesKey?: string }): Promise<{ webinarIds: string[] }> {
  const userId = requireStaffUser(ctx);
  const src = await lockWebinar(ctx.tx, input.webinarId);
  if (src.mode === "on_demand") throw new ValidationError("on_demand_has_no_start", { startsAt: "on_demand_has_no_start" });
  if (!input.startsAt.length || input.startsAt.length > MAX_DUPLICATES) throw new ValidationError("occurrence_count", { startsAt: `1_to_${MAX_DUPLICATES}` });
  const seriesKey = input.seriesKey ?? src.seriesKey ?? seriesKeyFrom(src.slug);
  if (src.seriesKey !== seriesKey) await ctx.tx.update(webinars).set({ seriesKey, updatedAt: ctx.now }).where(eq(webinars.id, src.id));

  const [polls, ctas, presenters] = await Promise.all([
    ctx.tx.select().from(webinarPolls).where(and(eq(webinarPolls.webinarId, src.id), eq(webinarPolls.isActive, true))).orderBy(asc(webinarPolls.sortOrder)),
    ctx.tx.select().from(webinarCtas).where(and(eq(webinarCtas.webinarId, src.id), eq(webinarCtas.isActive, true))).orderBy(asc(webinarCtas.sortOrder)),
    ctx.tx.select().from(webinarPresenters).where(eq(webinarPresenters.webinarId, src.id)).orderBy(asc(webinarPresenters.sortOrder)),
  ]);

  const webinarIds: string[] = [];
  for (const startsAt of [...input.startsAt].sort((a, b) => a.getTime() - b.getTime())) {
    let slug = occurrenceSlug(src.slug, startsAt);
    for (let n = 2; (await ctx.tx.select({ id: webinars.id }).from(webinars).where(eq(webinars.slug, slug))).length; n++) slug = occurrenceSlug(src.slug, startsAt, n);
    const id = randomUUID();
    await ctx.tx.insert(webinars).values({
      id,
      slug,
      seriesKey,
      title: src.title,
      description: src.description,
      locales: src.locales,
      spokenLocale: src.spokenLocale,
      mode: src.mode,
      startsAt,
      plannedDurationMinutes: src.plannedDurationMinutes,
      durationSec: src.mode === "simulive" ? src.durationSec : null,
      recordingVideoId: src.mode === "simulive" ? src.recordingVideoId : null,
      isReplayEnabled: src.isReplayEnabled,
      isReplayGated: src.isReplayGated,
      replayViewLimit: src.replayViewLimit,
      attendedMinSec: src.attendedMinSec,
      conversionWindowDays: src.conversionWindowDays,
      isChatEnabled: src.isChatEnabled,
      isQuestionsEnabled: src.isQuestionsEnabled,
      ownerUserId: src.ownerUserId,
      createdByUserId: userId,
    });
    if (polls.length) {
      await ctx.tx.insert(webinarPolls).values(
        polls.map((p) => ({
          webinarId: id,
          key: p.key,
          question: p.question,
          options: p.options,
          allowMultiple: p.allowMultiple,
          showAtSec: p.showAtSec,
          showForSec: p.showForSec,
          tagRules: p.tagRules,
          sortOrder: p.sortOrder,
        })),
      );
    }
    if (ctas.length) {
      await ctx.tx
        .insert(webinarCtas)
        .values(ctas.map((c) => ({ webinarId: id, key: c.key, label: c.label, url: c.url, showAtSec: c.showAtSec, showForSec: c.showForSec, sortOrder: c.sortOrder })));
    }
    if (presenters.length) {
      await ctx.tx
        .insert(webinarPresenters)
        .values(presenters.map((p) => ({ webinarId: id, userId: p.userId, personId: p.personId, displayName: p.displayName, role: p.role, sortOrder: p.sortOrder })));
    }
    webinarIds.push(id);
  }
  await auditWebinar(ctx, "webinar.duplicated", src, { newValue: { webinarIds, seriesKey, startsAt: input.startsAt } });
  return { webinarIds };
}

// ---------------------------------------------------------------------------------------------
// setWebinarVideo (edge case 7)
// ---------------------------------------------------------------------------------------------

/**
 * Stores a broadcast or recording id staff chose ("Use different YouTube video"); the enqueued
 * `webinar.fetch_recording` validates it with YouTube and reads the duration
 * (`broadcast_error = 'video_not_found'` when YouTube does not know it).
 */
export async function setWebinarVideo(
  ctx: Ctx,
  input: { webinarId: string; field: "youtube_video_id" | "recording_video_id"; videoId: string },
): Promise<Record<string, never>> {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  assertEditable(w);
  if (input.field === "youtube_video_id" && w.mode !== "live") throw new ValidationError("live_only", { field: "live_only" });
  const set: Partial<typeof webinars.$inferInsert> = { broadcastError: null, updatedAt: ctx.now };
  if (input.field === "youtube_video_id") Object.assign(set, { youtubeVideoId: input.videoId, youtubeStreamId: null, youtubeLifecycle: null });
  else if (w.recordingVideoId !== input.videoId) Object.assign(set, { recordingVideoId: input.videoId, durationSec: null });
  await ctx.tx.update(webinars).set(set).where(eq(webinars.id, w.id));
  await ctx.enqueue({
    kind: "webinar.fetch_recording",
    payload: { webinarId: w.id, videoId: input.videoId, field: input.field },
    key: jobKeys.recordingSet(w.id, input.videoId),
  });
  const before = input.field === "youtube_video_id" ? w.youtubeVideoId : w.recordingVideoId;
  await auditWebinar(ctx, "webinar.video_set", w, { oldValue: { [input.field]: before }, newValue: { [input.field]: input.videoId } });
  return {};
}

// ---------------------------------------------------------------------------------------------
// Polls and CTAs (rules 33-35 storage side, edge cases 15 and 16)
// ---------------------------------------------------------------------------------------------

async function hasInteractions(tx: Tx, column: "pollId" | "ctaId", id: string): Promise<boolean> {
  const col = column === "pollId" ? webinarInteractions.pollId : webinarInteractions.ctaId;
  const [row] = await tx.select({ id: webinarInteractions.id }).from(webinarInteractions).where(eq(col, id)).limit(1);
  return !!row;
}

/** Tag keys of the rules that `tags` does not know, and option keys the poll does not have (rule 35). */
async function tagRuleProblems(tx: Tx, input: Pick<UpsertPollInput, "tagRules" | "options">): Promise<Record<string, string>> {
  const problems: Record<string, string> = {};
  const optionKeys = new Set(input.options.map((o) => o.key));
  const badOptions = [...new Set(input.tagRules.flatMap((r) => r.option_keys).filter((k) => !optionKeys.has(k)))];
  if (badOptions.length) problems.tagRules = `unknown_options:${badOptions.join(",")}`;
  const wanted = [...new Set(input.tagRules.map((r) => r.tag_key))];
  if (wanted.length) {
    const known = new Set((await tx.select({ key: tags.key }).from(tags).where(inArray(tags.key, wanted))).map((t) => t.key));
    const unknown = wanted.filter((k) => !known.has(k));
    if (unknown.length) problems.tagRules = [problems.tagRules, `unknown_tags:${unknown.join(",")}`].filter(Boolean).join(";");
  }
  return problems;
}

/** Saving on a webinar that left `draft` runs the publish completeness check on the item (section 8). */
function assertItemComplete(w: WebinarRow, fields: Array<[string, LocalizedText]>): void {
  if (w.status === "draft") return;
  const missing = missingFields(fields, w.locales);
  if (Object.keys(missing).length) throw new ValidationError("missing_locales", missing);
}

/**
 * Creates or edits a poll. Once it has answers its key, question, options and single/multiple
 * choice are fixed (`conflict` `poll_answered`, edge case 15); timing, order and tag rules may
 * still change. Tag rules may only name existing tags and options (`validation`).
 */
export async function upsertPoll(ctx: Ctx, input: UpsertPollInput): Promise<{ pollId: string }> {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  assertEditable(w);
  const problems = await tagRuleProblems(ctx.tx, input);
  if (Object.keys(problems).length) throw new ValidationError("invalid_tag_rules", problems);
  assertItemComplete(w, pollTextFields({ key: input.key, question: input.question, options: input.options }));
  const values = {
    key: input.key,
    question: input.question,
    options: input.options,
    allowMultiple: input.allowMultiple,
    showAtSec: input.showAtSec ?? null,
    showForSec: input.showForSec,
    tagRules: input.tagRules,
    sortOrder: input.sortOrder,
    updatedAt: ctx.now,
  };
  try {
    let pollId = input.pollId;
    if (pollId) {
      const [poll] = await ctx.tx.select().from(webinarPolls).where(and(eq(webinarPolls.id, pollId), eq(webinarPolls.webinarId, w.id)));
      if (!poll) throw new NotFoundError("poll_not_found");
      const fixedChanged = poll.key !== input.key || !same(poll.question, input.question) || !same(poll.options, input.options) || poll.allowMultiple !== input.allowMultiple;
      if (fixedChanged && (await hasInteractions(ctx.tx, "pollId", poll.id))) throw new ConflictError("poll_answered");
      await ctx.tx.update(webinarPolls).set(values).where(eq(webinarPolls.id, poll.id));
    } else {
      const [row] = await ctx.tx.insert(webinarPolls).values({ ...values, webinarId: w.id }).returning({ id: webinarPolls.id });
      pollId = row!.id;
    }
    await ctx.audit({ action: "webinar.poll_saved", entityType: "webinar", entityId: w.id, newValue: { pollId, key: input.key } });
    return { pollId };
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("key_taken");
    throw error;
  }
}

/** Deletes a poll without answers; one with answers is deactivated so reports keep them. */
export async function deletePoll(ctx: Ctx, input: { pollId: string }): Promise<{ deactivated: boolean }> {
  const [poll] = await ctx.tx.select().from(webinarPolls).where(eq(webinarPolls.id, input.pollId));
  if (!poll) throw new NotFoundError("poll_not_found");
  const w = await lockWebinar(ctx.tx, poll.webinarId);
  const deactivated = await hasInteractions(ctx.tx, "pollId", poll.id);
  if (deactivated) await ctx.tx.update(webinarPolls).set({ isActive: false, updatedAt: ctx.now }).where(eq(webinarPolls.id, poll.id));
  else await ctx.tx.delete(webinarPolls).where(eq(webinarPolls.id, poll.id));
  await ctx.audit({ action: "webinar.poll_deleted", entityType: "webinar", entityId: w.id, oldValue: { pollId: poll.id, key: poll.key }, newValue: { deactivated } });
  return { deactivated };
}

/** Creates or edits a CTA. Once shown or clicked, its key and URL are fixed (`conflict` `cta_shown`). */
export async function upsertCta(ctx: Ctx, input: UpsertCtaInput): Promise<{ ctaId: string }> {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  assertEditable(w);
  assertItemComplete(w, [[`cta:${input.key}.label`, input.label]]);
  const values = { key: input.key, label: input.label, url: input.url, showAtSec: input.showAtSec ?? null, showForSec: input.showForSec, sortOrder: input.sortOrder, updatedAt: ctx.now };
  try {
    let ctaId = input.ctaId;
    if (ctaId) {
      const [cta] = await ctx.tx.select().from(webinarCtas).where(and(eq(webinarCtas.id, ctaId), eq(webinarCtas.webinarId, w.id)));
      if (!cta) throw new NotFoundError("cta_not_found");
      if ((cta.key !== input.key || cta.url !== input.url) && (await hasInteractions(ctx.tx, "ctaId", cta.id))) throw new ConflictError("cta_shown");
      await ctx.tx.update(webinarCtas).set(values).where(eq(webinarCtas.id, cta.id));
    } else {
      const [row] = await ctx.tx.insert(webinarCtas).values({ ...values, webinarId: w.id }).returning({ id: webinarCtas.id });
      ctaId = row!.id;
    }
    await ctx.audit({ action: "webinar.cta_saved", entityType: "webinar", entityId: w.id, newValue: { ctaId, key: input.key, url: input.url } });
    return { ctaId };
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("key_taken");
    throw error;
  }
}

export async function deleteCta(ctx: Ctx, input: { ctaId: string }): Promise<{ deactivated: boolean }> {
  const [cta] = await ctx.tx.select().from(webinarCtas).where(eq(webinarCtas.id, input.ctaId));
  if (!cta) throw new NotFoundError("cta_not_found");
  const w = await lockWebinar(ctx.tx, cta.webinarId);
  const deactivated = await hasInteractions(ctx.tx, "ctaId", cta.id);
  if (deactivated) await ctx.tx.update(webinarCtas).set({ isActive: false, updatedAt: ctx.now }).where(eq(webinarCtas.id, cta.id));
  else await ctx.tx.delete(webinarCtas).where(eq(webinarCtas.id, cta.id));
  await ctx.audit({ action: "webinar.cta_deleted", entityType: "webinar", entityId: w.id, oldValue: { ctaId: cta.id, key: cta.key }, newValue: { deactivated } });
  return { deactivated };
}

// ---------------------------------------------------------------------------------------------
// Presenters (principle 1: a staff user or a crm person)
// ---------------------------------------------------------------------------------------------

export type UpsertPresenterArgs = {
  webinarId: string;
  presenterId?: string;
  userId?: string;
  email?: string;
  displayName: string;
  role: "host" | "presenter" | "moderator";
};

/**
 * Adds or edits a presenter: a staff user by `userId`, or an external presenter by `email`
 * (`crm.findOrCreatePersonByEmail`, no consent written). The same user or person twice on one
 * webinar updates the existing row.
 */
export async function upsertPresenter(ctx: Ctx, input: UpsertPresenterArgs): Promise<{ presenterId: string }> {
  const w = await lockWebinar(ctx.tx, input.webinarId);
  assertEditable(w);
  const personId = input.email ? (await findOrCreatePersonByEmail(ctx.tx, ctx, { email: input.email, locale: ctx.locale })).personId : null;
  const userId = input.email ? null : (input.userId ?? null);
  if (!userId && !personId) throw new ValidationError("presenter_identity", { userId: "required" });
  const identity = userId ? eq(webinarPresenters.userId, userId) : eq(webinarPresenters.personId, personId!);
  const where = input.presenterId ? and(eq(webinarPresenters.id, input.presenterId), eq(webinarPresenters.webinarId, w.id)) : and(eq(webinarPresenters.webinarId, w.id), identity);
  const [existing] = await ctx.tx.select().from(webinarPresenters).where(where);
  if (input.presenterId && !existing) throw new NotFoundError("presenter_not_found");
  let presenterId: string;
  try {
    if (existing) {
      await ctx.tx
        .update(webinarPresenters)
        .set({ userId, personId, displayName: input.displayName, role: input.role, updatedAt: ctx.now })
        .where(eq(webinarPresenters.id, existing.id));
      presenterId = existing.id;
    } else {
      const [{ n } = { n: 0 }] = await ctx.tx.select({ n: sql<number>`count(*)::int` }).from(webinarPresenters).where(eq(webinarPresenters.webinarId, w.id));
      const [row] = await ctx.tx
        .insert(webinarPresenters)
        .values({ webinarId: w.id, userId, personId, displayName: input.displayName, role: input.role, sortOrder: Number(n) })
        .returning({ id: webinarPresenters.id });
      presenterId = row!.id;
    }
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("presenter_exists");
    throw error;
  }
  await ctx.audit({ action: "webinar.presenter_saved", entityType: "webinar", entityId: w.id, personId, newValue: { presenterId, userId, role: input.role } });
  return { presenterId };
}

export async function removePresenter(ctx: Ctx, input: { presenterId: string }): Promise<Record<string, never>> {
  const [p] = await ctx.tx.select().from(webinarPresenters).where(eq(webinarPresenters.id, input.presenterId));
  if (!p) throw new NotFoundError("presenter_not_found");
  await lockWebinar(ctx.tx, p.webinarId);
  await ctx.tx.delete(webinarPresenters).where(eq(webinarPresenters.id, p.id));
  await ctx.audit({ action: "webinar.presenter_removed", entityType: "webinar", entityId: p.webinarId, personId: p.personId, oldValue: { presenterId: p.id, displayName: p.displayName } });
  return {};
}

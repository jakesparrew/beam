/**
 * webinar's GDPR registration (webinar spec section 9, architecture section 11, OD-9). Facade
 * read by `pnpm gen:indexes`; ops runs export, erase and the retention sweeps. webinar-P1
 * registers the five person-referencing tables, the three tables without personal data, a first
 * export and erase, and the sweep handlers of the retention keys ops seeds (section 9.2); the
 * later webinar packages complete the export topics (webinar-P3 to webinar-P6). webinar-P4 adds
 * the raw segments as a CSV next to the merged watch per mode (section 9.1: "merged watch seconds
 * and thresholds plus the raw segments CSV"). webinar-P5 completes the interaction rows: the CTA
 * target of a click and the viewer's chat and questions with their text (section 9.1: "every row
 * with webinar title, mode, kind, poll question and chosen option labels, CTA label, text, time").
 * webinar-P6 completes it: every text follows the language of the registration the row belongs
 * to (a merged person's registration of the same webinar keeps its own), and the merged watch per
 * webinar is titled in the subject's own registration language.
 *
 * - `export` and `erase` cover every id of `crm.resolvePersonIds` (the subject and the persons
 *   merged into it).
 * - `erase` deletes the registrations (cascading into `watch_segments`, `webinar_interactions`
 *   and `webinar_moderation_actions` under `beam.allow_rewrite`) and the person's presenter
 *   rows. It runs before crm anonymises `persons`.
 * - `sweep`: `webinar.watch_segments` (by `recorded_at`), `webinar.webinar_interactions` (by
 *   `occurred_at`), `webinar.webinar_registrations` (registered before the cutoff, of a webinar
 *   that ended, was cancelled or archived before it; cascades). At most `SWEEP_BATCH` rows per
 *   call; ops calls again until a call returns 0.
 */
import type { Tx } from "@beam/db";
import {
  vWebinarWatch,
  watchSegments,
  webinarCtas,
  webinarInteractions,
  webinarModerationActions,
  webinarPolls,
  webinarPresenters,
  webinarRegistrations,
  webinars,
} from "@beam/db/schema";
import type { EraseReportRow, PrivacyExport, PrivacyRegistration } from "@beam/core/privacy";
import { asc, eq, inArray, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { resolvePersonIds } from "@/modules/crm/api";

/** Rows per sweep call (section 9.2). */
export const SWEEP_BATCH = 5000;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const allowRewrite = (tx: Tx) => tx.execute(sql`select set_config('beam.allow_rewrite', 'on', true)`);
const deletedCount = (result: unknown) => rowsOf<{ id: string }>(result).length;

/** Retention handlers keyed by the policy keys ops seeds (cross-module decisions 37, 59, 69). */
export const sweep: Record<string, (tx: Tx, cutoff: Date) => Promise<number>> = {
  "webinar.watch_segments": async (tx, cutoff) => {
    await allowRewrite(tx);
    return deletedCount(
      await tx.execute(sql`delete from watch_segments where id in (
          select id from watch_segments where recorded_at < ${cutoff} order by recorded_at, id limit ${SWEEP_BATCH})
        returning id`),
    );
  },
  "webinar.webinar_interactions": async (tx, cutoff) => {
    await allowRewrite(tx);
    return deletedCount(
      await tx.execute(sql`delete from webinar_interactions where id in (
          select id from webinar_interactions where occurred_at < ${cutoff} order by occurred_at, id limit ${SWEEP_BATCH})
        returning id`),
    );
  },
  "webinar.webinar_registrations": async (tx, cutoff) => {
    await allowRewrite(tx);
    return deletedCount(
      await tx.execute(sql`delete from webinar_registrations where id in (
          select r.id from webinar_registrations r join webinars w on w.id = r.webinar_id
          where r.created_at < ${cutoff}
            and (w.live_ended_at < ${cutoff} or (w.status in ('ended', 'cancelled', 'archived') and w.updated_at < ${cutoff}))
          order by r.created_at, r.id limit ${SWEEP_BATCH})
        returning id`),
    );
  },
};

type Label = Record<string, string | undefined> | null | undefined;

/** One RFC 4180 cell: quoted when it holds a comma, quote or line break. */
function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const text = String(v);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

type SegmentExportRow = { webinar_title: string | null; mode: string; from_sec: number; to_sec: number; recorded_at: string | null };

/** The raw watch segments as CSV (header first; one line per heartbeat). */
export function segmentsCsv(rows: readonly SegmentExportRow[]): string {
  const header = ["webinar_title", "mode", "from_sec", "to_sec", "recorded_at"];
  const lines = rows.map((r) => [r.webinar_title, r.mode, r.from_sec, r.to_sec, r.recorded_at].map(csvCell).join(","));
  return [header.join(","), ...lines].join("\r\n") + "\r\n";
}
const inLocale = (text: Label, locale: string) => (text ? (text[locale] ?? null) : null);

async function exportPerson(tx: Tx, personId: string): Promise<PrivacyExport> {
  const ids = await resolvePersonIds(tx, personId);

  const regs = await tx
    .select({ r: webinarRegistrations, title: webinars.title, mode: webinars.mode, startsAt: webinars.startsAt })
    .from(webinarRegistrations)
    .innerJoin(webinars, eq(webinars.id, webinarRegistrations.webinarId))
    .where(inArray(webinarRegistrations.personId, ids))
    .orderBy(asc(webinarRegistrations.createdAt), asc(webinarRegistrations.id));
  // The subject's own registration names the webinar (a merged person's one of the same webinar may have another language).
  const own = [...regs].sort((a, b) => Number(b.r.personId === personId) - Number(a.r.personId === personId));
  const titleOf = new Map([...own].reverse().map(({ r, title }) => [r.webinarId, inLocale(title, r.locale)]));
  /** Texts of an interaction follow the language of the registration it belongs to. */
  const localeOfReg = new Map(regs.map(({ r }) => [r.id, r.locale]));
  const titleOfReg = new Map(regs.map(({ r, title }) => [r.id, inLocale(title, r.locale)]));
  const regIds = regs.map(({ r }) => r.id);

  const registrations = regs.map(({ r, mode, startsAt }) => ({
    webinar_title: titleOfReg.get(r.id) ?? null,
    webinar_mode: mode,
    starts_at: iso(startsAt),
    registered_mode: r.registeredMode,
    status: r.status,
    source: r.source,
    locale: r.locale,
    registered_at: iso(r.createdAt),
    cancelled_at: iso(r.cancelledAt),
    utm: r.utm,
  }));

  const watch = (await tx.select().from(vWebinarWatch).where(inArray(vWebinarWatch.personId, ids))).map((w) => ({
    webinar_title: titleOf.get(w.webinarId) ?? null,
    mode: w.mode,
    watched_sec: w.watchedSec,
    max_position_sec: w.maxPositionSec,
    attended: w.isAttended,
    watched_15m: w.is15m,
    watched_30m: w.is30m,
    watched_half: w.isHalf,
    watched_to_end: w.isEnd,
    first_watched_at: iso(w.firstWatchedAt),
    last_watched_at: iso(w.lastWatchedAt),
  }));

  const segments = regIds.length
    ? (
        await tx
          .select()
          .from(watchSegments)
          .where(inArray(watchSegments.registrationId, regIds))
          .orderBy(asc(watchSegments.recordedAt), asc(watchSegments.id))
      ).map((s) => ({ webinar_title: titleOfReg.get(s.registrationId) ?? titleOf.get(s.webinarId) ?? null, mode: s.mode, from_sec: s.fromSec, to_sec: s.toSec, recorded_at: iso(s.recordedAt) }))
    : [];

  const interactions = regIds.length
    ? await tx
        .select({ i: webinarInteractions, question: webinarPolls.question, options: webinarPolls.options, ctaLabel: webinarCtas.label })
        .from(webinarInteractions)
        .leftJoin(webinarPolls, eq(webinarPolls.id, webinarInteractions.pollId))
        .leftJoin(webinarCtas, eq(webinarCtas.id, webinarInteractions.ctaId))
        .where(inArray(webinarInteractions.registrationId, regIds))
        .orderBy(asc(webinarInteractions.occurredAt), asc(webinarInteractions.id))
    : [];
  const interactionRows = interactions.map(({ i, question, options, ctaLabel }) => {
    const locale = localeOfReg.get(i.registrationId) ?? "nl-BE";
    const chosen = Array.isArray(i.payload.option_keys) ? (i.payload.option_keys as string[]) : null;
    return {
      webinar_title: titleOfReg.get(i.registrationId) ?? titleOf.get(i.webinarId) ?? null,
      mode: i.mode,
      kind: i.kind,
      poll_question: inLocale(question, locale),
      poll_answer: chosen && options ? chosen.map((k) => inLocale(options.find((o) => o.key === k)?.label, locale) ?? k) : null,
      cta_label: inLocale(ctaLabel, locale),
      cta_url: typeof i.payload.url === "string" ? i.payload.url : null,
      text: typeof i.payload.text === "string" ? i.payload.text : null,
      at_sec: i.atSec,
      occurred_at: iso(i.occurredAt),
    };
  });

  const moderation = regIds.length
    ? (
        await tx
          .select()
          .from(webinarModerationActions)
          .where(inArray(webinarModerationActions.registrationId, regIds))
          .orderBy(asc(webinarModerationActions.createdAt), asc(webinarModerationActions.id))
      ).map((m) => ({ webinar_title: titleOfReg.get(m.registrationId) ?? titleOf.get(m.webinarId) ?? null, action: m.action, at: iso(m.createdAt) }))
    : [];

  const presenters = (
    await tx
      .select({ p: webinarPresenters, title: webinars.title })
      .from(webinarPresenters)
      .innerJoin(webinars, eq(webinars.id, webinarPresenters.webinarId))
      .where(inArray(webinarPresenters.personId, ids))
      .orderBy(asc(webinarPresenters.createdAt), asc(webinarPresenters.id))
  ).map(({ p, title }) => ({ webinar_title: inLocale(title, "en") ?? inLocale(title, "nl-BE"), role: p.role, display_name: p.displayName }));

  return {
    "webinar/registrations.json": registrations,
    "webinar/watch.json": watch,
    "webinar/watch_segments.json": segments,
    "webinar/watch_segments.csv": segmentsCsv(segments),
    "webinar/interactions.json": interactionRows,
    "webinar/moderation.json": moderation,
    "webinar/presenters.json": presenters,
  };
}

async function erasePerson(tx: Tx, personId: string): Promise<EraseReportRow[]> {
  await allowRewrite(tx);
  const ids = await resolvePersonIds(tx, personId);
  const regIds = (await tx.select({ id: webinarRegistrations.id }).from(webinarRegistrations).where(inArray(webinarRegistrations.personId, ids))).map(
    (r) => r.id,
  );
  const n = sql<number>`count(*)::int`;
  const first = (rows: Array<{ n: number }>) => Number(rows[0]?.n ?? 0);
  const segments = regIds.length ? first(await tx.select({ n }).from(watchSegments).where(inArray(watchSegments.registrationId, regIds))) : 0;
  const interactions = regIds.length
    ? first(await tx.select({ n }).from(webinarInteractions).where(inArray(webinarInteractions.registrationId, regIds)))
    : 0;
  const moderation = regIds.length
    ? first(await tx.select({ n }).from(webinarModerationActions).where(inArray(webinarModerationActions.registrationId, regIds)))
    : 0;
  const registrations = regIds.length
    ? (await tx.delete(webinarRegistrations).where(inArray(webinarRegistrations.id, regIds)).returning({ id: webinarRegistrations.id })).length
    : 0;
  const presenters = (await tx.delete(webinarPresenters).where(inArray(webinarPresenters.personId, ids)).returning({ id: webinarPresenters.id })).length;
  return [
    { table: "webinar_registrations", rows: registrations, action: "deleted" },
    { table: "watch_segments", rows: segments, action: "deleted" },
    { table: "webinar_interactions", rows: interactions, action: "deleted" },
    { table: "webinar_moderation_actions", rows: moderation, action: "deleted" },
    { table: "webinar_presenters", rows: presenters, action: "deleted" },
  ];
}

export const privacy: PrivacyRegistration<Tx> = {
  tables: ["webinar_registrations", "watch_segments", "webinar_interactions", "webinar_moderation_actions", "webinar_presenters"],
  export: exportPerson,
  erase: erasePerson,
  sweep,
};

/** The spec's name for the registration (section 9.1). */
export const webinarPrivacy = privacy;

/** Webinar tables without a person reference (`owner_user_id`, `created_by_user_id` are staff). */
export const noPiiTables = ["webinars", "webinar_polls", "webinar_ctas"] as const;

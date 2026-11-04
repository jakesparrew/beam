/**
 * Schedule jobs (booking spec 4.5, R1-R4): `sessions.materialise`, `sessions.regenerate_template`,
 * `sessions.regenerate_date`, registered in `../jobs.ts` (booking-P1) and implemented here by
 * booking-P2, plus the internal `materialiseRange(tx, fromOn, toOn)`.
 *
 * A session is "touched" when it has any booking row, order line, waitlist entry or hold, when
 * staff changed it (`has_manual_changes`) or when its status is not `open`: automation never
 * updates or deletes a touched session (R2, R3). The rows a job may change are locked
 * `for update`, so a booking that takes the session lock first makes the session touched.
 */
import { z } from "zod";
import type { DbOrTx } from "@beam/db";
import { sessionTemplates, sessions } from "@beam/db/schema";
import {
  MATERIALISE_DAYS,
  addDays,
  brusselsDate,
  diffTemplateSessions,
  planOccurrences,
  suppresses,
  brusselsTime,
  zonedTimeToUtc,
  type ExceptionLike,
  type TemplateLike,
} from "@beam/core/booking";
import { and, asc, eq, gt, gte, inArray, isNotNull, lt, sql } from "@/lib/ctx";
import { PermanentError, type JobCtx } from "@/lib/job-runner";
import { loadExceptionRows, toExceptionLike } from "../api/schedule";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `{ fromOn?, days? }`; continuations carry `fromOn` (key `materialise:<run date>:<fromOn>`). */
export const MaterialiseInput = z.object({ fromOn: isoDate.optional(), days: z.number().int().min(1).max(90).optional() });
export const RegenerateTemplateInput = z.object({ templateId: z.uuid() });
export const RegenerateDateInput = z.object({ onDate: isoDate });

/** Dates per materialisation chunk; the job continues itself for the rest of the window. */
export const MATERIALISE_CHUNK_DAYS = 30;

export type TemplateRow = typeof sessionTemplates.$inferSelect;

/**
 * Materialised event templates need an `event_category` (sessions check); templates carry
 * none, so their sessions get `special_activity` (decision of booking-P2).
 */
export const TEMPLATE_EVENT_CATEGORY = "special_activity" as const;

const DAY_MS = 86_400_000;

export function templateLike(t: TemplateRow): TemplateLike {
  return { id: t.id, weekdays: t.weekdays, startTime: t.startTime, durationMinutes: t.durationMinutes, activeFromOn: t.activeFromOn, activeToOn: t.activeToOn };
}

/** The columns a template gives its sessions (R1; R2 updates the same ones). */
function templateColumns(t: TemplateRow) {
  return {
    templateVersion: t.version,
    kind: t.kind,
    title: t.name,
    description: t.description,
    capacitySeats: t.capacitySeats,
    capacityBeds: t.capacityBeds,
    creditKind: t.creditKind,
    creditCost: t.creditCost,
    productId: t.productId,
    isMemberOnly: t.isMemberOnly,
    location: t.location,
    eventCategory: t.kind === "event" ? TEMPLATE_EVENT_CATEGORY : null,
  };
}

async function insertOccurrences(tx: DbOrTx, t: TemplateRow, starts: Date[], publishedAt: Date): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < starts.length; i += 500) {
    const rows = starts.slice(i, i + 500).map((startsAt) => ({
      ...templateColumns(t),
      templateId: t.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + t.durationMinutes * 60_000),
      publishedAt,
    }));
    const out = await tx
      .insert(sessions)
      .values(rows)
      .onConflictDoNothing({ target: [sessions.templateId, sessions.startsAt], where: sql`${sessions.templateId} is not null` })
      .returning({ id: sessions.id });
    inserted += out.length;
  }
  return inserted;
}

/** The UTC instant at which a Brussels date begins. */
export const brusselsDayStart = (onDate: string): Date => zonedTimeToUtc(onDate, "00:00");
const zonedMidnight = brusselsDayStart;

/**
 * R1: inserts the missing sessions of every active template for the Brussels dates
 * `[fromOn, toOn]` (exceptions applied, `on conflict (template_id, starts_at) do nothing`).
 * Occurrences before `opts.notBefore` are skipped. Returns the number of inserted sessions.
 */
export async function materialiseRange(tx: DbOrTx, fromOn: string, toOn: string, opts: { notBefore?: Date; now?: Date } = {}): Promise<{ inserted: number }> {
  if (toOn < fromOn) return { inserted: 0 };
  const templates = await tx.select().from(sessionTemplates).where(eq(sessionTemplates.isActive, true)).orderBy(asc(sessionTemplates.createdAt));
  if (templates.length === 0) return { inserted: 0 };
  const exceptions = (await loadExceptionRows(tx, fromOn, toOn)).map(toExceptionLike);
  const now = opts.now ?? new Date();
  let inserted = 0;
  for (const t of templates) {
    const starts = planOccurrences(templateLike(t), exceptions, fromOn, toOn)
      .map((o) => o.startsAt)
      .filter((s) => !opts.notBefore || s.getTime() > opts.notBefore.getTime());
    inserted += await insertOccurrences(tx, t, starts, now);
  }
  return { inserted };
}

type ExistingRow = {
  id: string;
  templateId: string | null;
  startsAt: Date;
  hasManualChanges: boolean;
  status: string;
  hasBookings: boolean;
  hasEntries: boolean;
  hasHolds: boolean;
};

/** Future template sessions in `[from, to)`, locked, with what makes them touched. */
async function lockExisting(tx: DbOrTx, where: ReturnType<typeof and>): Promise<ExistingRow[]> {
  const rows = await tx
    .select({
      id: sessions.id,
      templateId: sessions.templateId,
      startsAt: sessions.startsAt,
      hasManualChanges: sessions.hasManualChanges,
      status: sessions.status,
      hasBookings: sql<boolean>`(exists (select 1 from bookings b where b.session_id = "sessions"."id") or exists (select 1 from order_lines ol where ol.session_id = "sessions"."id"))`,
      hasEntries: sql<boolean>`exists (select 1 from waitlist_entries w where w.session_id = "sessions"."id")`,
      hasHolds: sql<boolean>`exists (select 1 from capacity_holds c where c.session_id = "sessions"."id")`,
    })
    .from(sessions)
    .where(where)
    .orderBy(asc(sessions.startsAt))
    .for("update", { of: sessions });
  return rows;
}

const toExisting = (r: ExistingRow) => ({
  id: r.id,
  startsAt: r.startsAt,
  hasBookings: r.hasBookings,
  hasWaitlistEntries: r.hasEntries,
  hasHolds: r.hasHolds,
  // A closed or cancelled session was changed by staff: never reset it.
  hasManualChanges: r.hasManualChanges || r.status !== "open",
});

export type RegenerateResult = { inserted: number; updated: number; removed: number; untouched: number };

/** R2, R3: regenerates the untouched future sessions of one template in the 90-day window. */
export async function regenerateTemplate(tx: DbOrTx, templateId: string, now: Date): Promise<RegenerateResult> {
  const [t] = await tx.select().from(sessionTemplates).where(eq(sessionTemplates.id, templateId));
  if (!t) throw new PermanentError(`unknown session template ${templateId}`);
  const fromOn = brusselsDate(now);
  const toOn = addDays(fromOn, MATERIALISE_DAYS);
  const windowEnd = zonedMidnight(addDays(toOn, 1));
  const exceptions = (await loadExceptionRows(tx, fromOn, toOn)).map(toExceptionLike);
  const planned = t.isActive ? planOccurrences(templateLike(t), exceptions, fromOn, toOn).filter((p) => p.startsAt.getTime() > now.getTime()) : [];
  const existing = await lockExisting(tx, and(eq(sessions.templateId, t.id), gt(sessions.startsAt, now), lt(sessions.startsAt, windowEnd)));
  const diff = diffTemplateSessions(planned, existing.map(toExisting));
  if (diff.update.length) {
    await tx
      .update(sessions)
      .set({ ...templateColumns(t), endsAt: sql`${sessions.startsAt} + make_interval(mins => ${t.durationMinutes})`, updatedAt: sql`now()` })
      .where(inArray(sessions.id, diff.update));
  }
  if (diff.remove.length) await tx.delete(sessions).where(inArray(sessions.id, diff.remove));
  const inserted = await insertOccurrences(tx, t, diff.insert, now);
  return { inserted, updated: diff.update.length, removed: diff.remove.length, untouched: diff.untouched.length };
}

export type DateConflict = { sessionId: string; startsAt: Date; liveBookings: number };

/**
 * R4: the sessions of `onDate` that the date's exceptions suppress but that have live bookings
 * (`reserved` or `confirmed`); the exception screen lists them with "Cancel these sessions".
 */
export async function dateConflicts(tx: DbOrTx, onDate: string, now: Date = new Date()): Promise<DateConflict[]> {
  const exceptions = (await loadExceptionRows(tx, onDate, onDate)).map(toExceptionLike);
  if (exceptions.length === 0) return [];
  const rows = await tx
    .select({
      sessionId: sessions.id,
      templateId: sessions.templateId,
      startsAt: sessions.startsAt,
      liveBookings: sql<number>`(select count(*)::int from bookings b where b.session_id = "sessions"."id" and b.status in ('reserved', 'confirmed'))`,
    })
    .from(sessions)
    .where(
      and(
        isNotNull(sessions.templateId),
        gte(sessions.startsAt, zonedMidnight(onDate)),
        lt(sessions.startsAt, zonedMidnight(addDays(onDate, 1))),
        gt(sessions.startsAt, now),
        sql`${sessions.status} <> 'cancelled'`,
      ),
    )
    .orderBy(asc(sessions.startsAt));
  return rows
    .filter((r) => Number(r.liveBookings) > 0 && exceptions.some((e: ExceptionLike) => suppresses(e, r.templateId ?? undefined, brusselsTime(r.startsAt))))
    .map((r) => ({ sessionId: r.sessionId, startsAt: r.startsAt, liveBookings: Number(r.liveBookings) }));
}

export type RegenerateDateResult = { inserted: number; removed: number; conflicts: DateConflict[] };

/** R4: removes the suppressed untouched sessions of a date and re-inserts the allowed ones. */
export async function regenerateDate(tx: DbOrTx, onDate: string, now: Date): Promise<RegenerateDateResult> {
  const today = brusselsDate(now);
  if (onDate < today || onDate > addDays(today, MATERIALISE_DAYS)) return { inserted: 0, removed: 0, conflicts: [] };
  const exceptions = (await loadExceptionRows(tx, onDate, onDate)).map(toExceptionLike);
  const existing = await lockExisting(
    tx,
    and(isNotNull(sessions.templateId), gte(sessions.startsAt, zonedMidnight(onDate)), lt(sessions.startsAt, zonedMidnight(addDays(onDate, 1))), gt(sessions.startsAt, now)),
  );
  const templateIds = [...new Set(existing.map((e) => e.templateId!))];
  const templates = await tx
    .select()
    .from(sessionTemplates)
    .where(templateIds.length ? sql`${sessionTemplates.isActive} = true or ${inArray(sessionTemplates.id, templateIds)}` : eq(sessionTemplates.isActive, true));
  let inserted = 0;
  let removed = 0;
  for (const t of templates) {
    const planned = t.isActive ? planOccurrences(templateLike(t), exceptions, onDate, onDate).filter((p) => p.startsAt.getTime() > now.getTime()) : [];
    const mine = existing.filter((e) => e.templateId === t.id).map(toExisting);
    const diff = diffTemplateSessions(planned, mine);
    // Only R4's two effects: free suppressed sessions go, allowed ones come back. Updates are R2's.
    if (diff.remove.length) {
      await tx.delete(sessions).where(inArray(sessions.id, diff.remove));
      removed += diff.remove.length;
    }
    inserted += await insertOccurrences(tx, t, diff.insert, now);
  }
  return { inserted, removed, conflicts: await dateConflicts(tx, onDate, now) };
}

/** R1: ensures every active template's sessions for `[today, today + 90]` (30-day chunks). */
export async function runMaterialise(ctx: JobCtx, input: z.infer<typeof MaterialiseInput>): Promise<{ fromOn: string; toOn: string; inserted: number; continuedFrom: string | null }> {
  const today = brusselsDate(ctx.now);
  const fromOn = input.fromOn ?? today;
  const end = addDays(fromOn, input.days ?? MATERIALISE_DAYS);
  let toOn = addDays(fromOn, MATERIALISE_CHUNK_DAYS - 1);
  // A continuation needs at least one day; the last day joins the chunk before it.
  if (toOn >= addDays(end, -1)) toOn = end;
  const { inserted } = await materialiseRange(ctx.tx, fromOn, toOn, { notBefore: ctx.now, now: ctx.now });
  let continuedFrom: string | null = null;
  if (toOn < end) {
    continuedFrom = addDays(toOn, 1);
    const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${continuedFrom}T00:00:00Z`)) / DAY_MS);
    await ctx.enqueue({ kind: "sessions.materialise", payload: { fromOn: continuedFrom, days }, key: `materialise:${today}:${continuedFrom}`, lane: "bulk" });
  }
  return { fromOn, toOn, inserted, continuedFrom };
}

/** R2, R3: regenerates the untouched future sessions of one template. */
export function runRegenerateTemplate(ctx: JobCtx, input: z.infer<typeof RegenerateTemplateInput>): Promise<RegenerateResult> {
  return regenerateTemplate(ctx.tx, input.templateId, ctx.now);
}

/** R4: removes suppressed untouched sessions of a date and re-inserts the allowed ones. */
export function runRegenerateDate(ctx: JobCtx, input: z.infer<typeof RegenerateDateInput>): Promise<RegenerateDateResult> {
  return regenerateDate(ctx.tx, input.onDate, ctx.now);
}


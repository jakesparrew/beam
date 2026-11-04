"use server";
/**
 * booking server actions, area `templates` (booking spec 4.2, R1-R4b; booking-P2):
 * `createTemplates`, `updateTemplate`, `setTemplateActive`, `upsertException`,
 * `deleteException`, all staff with `settings.write`. Every edit bumps the row's `version` and
 * enqueues the regeneration job in the same transaction (`regenerate:<template_id>:<version>`,
 * `regenerate_date:<on_date>:<exception_id>:<version|deleted>`). A "use server" file exports
 * async functions only, so the Zod inputs and helpers stay unexported.
 */
import { z } from "zod";
import { sessionExceptions, sessionTemplates } from "@beam/db/schema";
import { BookingConflictError, MATERIALISE_DAYS, addDays, brusselsDate, planOccurrences, timeToMinutes } from "@beam/core/booking";
import { LocalizedTextSchema, missingLocales, type LocalizedText } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { NotFoundError, ValidationError, eq, sql, type Ctx } from "@/lib/ctx";
import { getSetting } from "@/lib/settings";
import { loadExceptionRows, toExceptionLike } from "../api/schedule";
import { dateConflicts, templateLike, type DateConflict, type TemplateRow } from "../jobs/schedule";
import { locationOverlaps, outsideBusinessHours } from "../queries/schedule";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

const TemplateFields = z.object({
  kind: z.enum(["day", "night", "event"]),
  name: LocalizedTextSchema,
  description: LocalizedTextSchema.nullish(),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  durationMinutes: z.number().int().min(15).max(1440),
  capacitySeats: z.number().int().min(0).nullish(),
  capacityBeds: z.number().int().min(0).nullish(),
  creditKind: z.enum(["day", "night"]).nullish(),
  creditCost: z.number().int().min(0).max(10).default(1),
  productId: z.uuid().nullish(),
  isMemberOnly: z.boolean().default(false),
  location: z.string().trim().max(200).nullish(),
  activeFromOn: isoDate,
  activeToOn: isoDate.nullish(),
});

const CreateTemplatesInput = TemplateFields.extend({ startTimes: z.array(hhmm).min(1).max(12) });

const UpdateTemplateInput = TemplateFields.partial().extend({
  id: z.uuid(),
  expectedVersion: z.number().int().min(1),
  startTime: hhmm.optional(),
  creditCost: z.number().int().min(0).max(10).optional(),
  isMemberOnly: z.boolean().optional(),
});

const SetTemplateActiveInput = z.object({ id: z.uuid(), isActive: z.boolean() });

const ExceptionInput = z.object({
  id: z.uuid().optional(),
  onDate: isoDate,
  kind: z.enum(["closed", "holiday", "special_hours"]),
  templateIds: z.array(z.uuid()).max(100).nullish(),
  opensAt: hhmm.nullish(),
  closesAt: hhmm.nullish(),
  name: LocalizedTextSchema,
  note: z.string().trim().max(2000).nullish(),
});

const DeleteExceptionInput = z.object({ id: z.uuid() });

export type ScheduleWarning = { code: "location_overlap" | "outside_business_hours"; detail: string };

type Shape = {
  kind: "day" | "night" | "event";
  capacitySeats?: number | null;
  capacityBeds?: number | null;
  creditKind?: "day" | "night" | null;
  activeFromOn: string;
  activeToOn?: string | null;
  weekdays: number[];
};

/** The table checks of `session_templates`, as `validation` fields instead of a database error. */
function assertShape(v: Shape): void {
  const fields: Record<string, string> = {};
  if (v.kind === "night" && v.capacityBeds == null) fields.capacityBeds = "required";
  if (v.kind !== "night" && v.capacityBeds != null) fields.capacityBeds = "night_only";
  if (v.kind !== "night" && v.capacitySeats == null) fields.capacitySeats = "required";
  if (v.kind !== "event" && v.creditKind == null) fields.creditKind = "required";
  if (v.activeToOn && v.activeToOn < v.activeFromOn) fields.activeToOn = "before_active_from";
  if (new Set(v.weekdays).size !== v.weekdays.length) fields.weekdays = "duplicate";
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);
}

/** `assertComplete` as `validation` with one field per missing locale (section 8). */
function assertCompleteText(text: LocalizedText | null | undefined, field: string): void {
  const missing = missingLocales(text);
  if (missing.length) throw new ValidationError(`missing_translation: ${field}`, Object.fromEntries(missing.map((l) => [`${field}.${l}`, "missing"])));
}

const isFilled = (text: LocalizedText | null | undefined) => !!text && Object.values(text).some((v) => typeof v === "string" && v.trim().length > 0);

/** A name is complete, and so is the description when it has any text (section 8). */
function isPublishable(name: LocalizedText, description: LocalizedText | null | undefined): boolean {
  return missingLocales(name).length === 0 && (!isFilled(description) || missingLocales(description).length === 0);
}

const userIdOf = (ctx: Ctx) => (ctx.actor.kind === "staff" ? ctx.actor.userId : null);

/** R6b and 3.0b warnings of a template over the 90-day window. */
async function templateWarnings(ctx: Ctx, t: TemplateRow, excludeTemplateIds: string[]): Promise<ScheduleWarning[]> {
  const warnings: ScheduleWarning[] = [];
  const hours = await getSetting(ctx.tx, "business_hours");
  for (const wd of outsideBusinessHours(hours, t)) warnings.push({ code: "outside_business_hours", detail: String(wd) });
  if (t.location) {
    const today = brusselsDate(ctx.now);
    const toOn = addDays(today, MATERIALISE_DAYS);
    const exceptions = (await loadExceptionRows(ctx.tx, today, toOn)).map(toExceptionLike);
    const slots = planOccurrences(templateLike(t), exceptions, today, toOn).filter((s) => s.startsAt > ctx.now);
    for (const id of (await locationOverlaps(ctx.tx, t.location, slots, { excludeTemplateIds })).slice(0, 20)) warnings.push({ code: "location_overlap", detail: id });
  }
  return warnings;
}

async function enqueueTemplateRegeneration(ctx: Ctx, t: { id: string; version: number }): Promise<string> {
  const job = await ctx.enqueue({ kind: "sessions.regenerate_template", payload: { templateId: t.id }, key: `regenerate:${t.id}:${t.version}` });
  return job.id;
}

async function enqueueDateRegeneration(ctx: Ctx, onDate: string, exceptionId: string, version: number | "deleted"): Promise<string> {
  const job = await ctx.enqueue({ kind: "sessions.regenerate_date", payload: { onDate }, key: `regenerate_date:${onDate}:${exceptionId}:${version}` });
  return job.id;
}

/**
 * "Add schedule": one template per start time (a day with four blocks is four templates). A
 * template is active only when its name (and description, when given) is complete in the three
 * locales; each active one gets its sessions through `sessions.regenerate_template`.
 */
export const createTemplates = action(
  { name: "booking.create_templates", audience: "staff", permission: "settings.write", input: CreateTemplatesInput, audit: { entityType: "session_template", entityId: (_i, o: { templateIds: string[]; warnings: ScheduleWarning[] }) => o.templateIds[0] ?? null } },
  async (ctx, input): Promise<{ templateIds: string[]; warnings: ScheduleWarning[] }> => {
    assertShape(input);
    const starts = [...new Set(input.startTimes)].sort();
    const isActive = isPublishable(input.name, input.description);
    const rows = await ctx.tx
      .insert(sessionTemplates)
      .values(
        starts.map((startTime) => ({
          kind: input.kind,
          name: input.name,
          description: isFilled(input.description) ? input.description : null,
          weekdays: [...input.weekdays].sort((a, b) => a - b),
          startTime,
          durationMinutes: input.durationMinutes,
          capacitySeats: input.kind === "night" ? (input.capacitySeats ?? null) : input.capacitySeats!,
          capacityBeds: input.kind === "night" ? input.capacityBeds! : null,
          creditKind: input.creditKind ?? null,
          creditCost: input.creditCost,
          productId: input.productId ?? null,
          isMemberOnly: input.isMemberOnly,
          location: input.location || null,
          activeFromOn: input.activeFromOn,
          activeToOn: input.activeToOn ?? null,
          isActive,
          createdByUserId: userIdOf(ctx),
        })),
      )
      .returning();
    const ids = rows.map((r) => r.id);
    const warnings: ScheduleWarning[] = [];
    for (const row of rows) {
      if (row.isActive) await enqueueTemplateRegeneration(ctx, row);
      for (const w of await templateWarnings(ctx, row, ids)) if (!warnings.some((x) => x.code === w.code && x.detail === w.detail)) warnings.push(w);
    }
    return { templateIds: ids, warnings };
  },
);

/** R2: edits a template, bumps its version and enqueues the regeneration of its sessions. */
export const updateTemplate = action(
  { name: "booking.update_template", audience: "staff", permission: "settings.write", input: UpdateTemplateInput, audit: { entityType: "session_template", entityId: (i) => i.id } },
  async (ctx, input): Promise<{ id: string; version: number; regenerationJobId: string; warnings: ScheduleWarning[] }> => {
    const [current] = await ctx.tx.select().from(sessionTemplates).where(eq(sessionTemplates.id, input.id)).for("update");
    if (!current) throw new NotFoundError("template_not_found");
    if (current.version !== input.expectedVersion) throw new BookingConflictError("stale_version", { version: current.version });
    const { id: _id, expectedVersion: _v, ...patch } = input;
    const next = {
      kind: patch.kind ?? current.kind,
      name: (patch.name ?? current.name) as LocalizedText,
      description: patch.description === undefined ? (current.description as LocalizedText | null) : isFilled(patch.description) ? patch.description : null,
      weekdays: patch.weekdays ? [...patch.weekdays].sort((a, b) => a - b) : current.weekdays,
      startTime: patch.startTime ?? current.startTime.slice(0, 5),
      durationMinutes: patch.durationMinutes ?? current.durationMinutes,
      capacitySeats: patch.capacitySeats === undefined ? current.capacitySeats : patch.capacitySeats,
      capacityBeds: patch.capacityBeds === undefined ? current.capacityBeds : patch.capacityBeds,
      creditKind: patch.creditKind === undefined ? current.creditKind : patch.creditKind,
      creditCost: patch.creditCost ?? current.creditCost,
      productId: patch.productId === undefined ? current.productId : patch.productId,
      isMemberOnly: patch.isMemberOnly ?? current.isMemberOnly,
      location: patch.location === undefined ? current.location : patch.location || null,
      activeFromOn: patch.activeFromOn ?? current.activeFromOn,
      activeToOn: patch.activeToOn === undefined ? current.activeToOn : patch.activeToOn,
    };
    assertShape(next);
    if (current.isActive) {
      assertCompleteText(next.name, "name");
      if (isFilled(next.description)) assertCompleteText(next.description, "description");
    }
    timeToMinutes(next.startTime);
    const [row] = await ctx.tx
      .update(sessionTemplates)
      .set({ ...next, version: current.version + 1, updatedAt: sql`now()` })
      .where(eq(sessionTemplates.id, current.id))
      .returning();
    const regenerationJobId = await enqueueTemplateRegeneration(ctx, row!);
    return { id: row!.id, version: row!.version, regenerationJobId, warnings: await templateWarnings(ctx, row!, [row!.id]) };
  },
);

/** Activates (name complete in three locales) or deactivates a template; sessions follow by R2. */
export const setTemplateActive = action(
  { name: "booking.set_template_active", audience: "staff", permission: "settings.write", input: SetTemplateActiveInput, audit: { entityType: "session_template", entityId: (i) => i.id } },
  async (ctx, input): Promise<{ id: string }> => {
    const [current] = await ctx.tx.select().from(sessionTemplates).where(eq(sessionTemplates.id, input.id)).for("update");
    if (!current) throw new NotFoundError("template_not_found");
    if (current.isActive === input.isActive) return { id: current.id };
    if (input.isActive) {
      assertCompleteText(current.name as LocalizedText, "name");
      if (isFilled(current.description as LocalizedText | null)) assertCompleteText(current.description as LocalizedText, "description");
    }
    const [row] = await ctx.tx
      .update(sessionTemplates)
      .set({ isActive: input.isActive, version: current.version + 1, updatedAt: sql`now()` })
      .where(eq(sessionTemplates.id, current.id))
      .returning();
    await enqueueTemplateRegeneration(ctx, row!);
    return { id: row!.id };
  },
);

/**
 * R4: creates or edits a closed day, holiday or special-hours exception (name complete in three
 * locales) and enqueues `sessions.regenerate_date` for its date (and the old date when it
 * moved). Returns the sessions of the date that keep live bookings (nothing is cancelled).
 */
export const upsertException = action(
  { name: "booking.upsert_exception", audience: "staff", permission: "settings.write", input: ExceptionInput, audit: { entityType: "session_exception", entityId: (_i, o: { id: string; conflicts: DateConflict[] }) => o.id } },
  async (ctx, input): Promise<{ id: string; conflicts: DateConflict[] }> => {
    assertCompleteText(input.name, "name");
    const special = input.kind === "special_hours";
    if (special && (!input.opensAt || !input.closesAt)) throw new ValidationError("validation", { ...(input.opensAt ? {} : { opensAt: "required" }), ...(input.closesAt ? {} : { closesAt: "required" }) });
    if (special && timeToMinutes(input.closesAt!) <= timeToMinutes(input.opensAt!)) throw new ValidationError("validation", { closesAt: "not_after_opens" });
    const values = {
      onDate: input.onDate,
      kind: input.kind,
      templateIds: input.templateIds?.length ? [...new Set(input.templateIds)] : null,
      opensAt: special ? input.opensAt! : null,
      closesAt: special ? input.closesAt! : null,
      name: input.name,
      note: input.note || null,
    };
    let row: typeof sessionExceptions.$inferSelect;
    if (input.id) {
      const [current] = await ctx.tx.select().from(sessionExceptions).where(eq(sessionExceptions.id, input.id)).for("update");
      if (!current) throw new NotFoundError("exception_not_found");
      [row] = (await ctx.tx
        .update(sessionExceptions)
        .set({ ...values, version: current.version + 1, updatedAt: sql`now()` })
        .where(eq(sessionExceptions.id, current.id))
        .returning()) as [typeof sessionExceptions.$inferSelect];
      if (current.onDate !== row.onDate) await enqueueDateRegeneration(ctx, current.onDate, row.id, row.version);
    } else {
      [row] = (await ctx.tx.insert(sessionExceptions).values({ ...values, createdByUserId: userIdOf(ctx) }).returning()) as [typeof sessionExceptions.$inferSelect];
    }
    await enqueueDateRegeneration(ctx, row.onDate, row.id, row.version);
    return { id: row.id, conflicts: await dateConflicts(ctx.tx, row.onDate, ctx.now) };
  },
);

/** R4: deletes an exception; `sessions.regenerate_date` re-inserts the sessions it suppressed. */
export const deleteException = action(
  { name: "booking.delete_exception", audience: "staff", permission: "settings.write", input: DeleteExceptionInput, audit: { entityType: "session_exception", entityId: (i) => i.id } },
  async (ctx, input): Promise<{ id: string; conflicts: DateConflict[] }> => {
    const [row] = await ctx.tx.delete(sessionExceptions).where(eq(sessionExceptions.id, input.id)).returning();
    if (!row) throw new NotFoundError("exception_not_found");
    await enqueueDateRegeneration(ctx, row.onDate, row.id, "deleted");
    return { id: row.id, conflicts: await dateConflicts(ctx.tx, row.onDate, ctx.now) };
  },
);

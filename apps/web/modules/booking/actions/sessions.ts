"use server";
/**
 * booking server actions, area `sessions` (booking spec 4.2, R5, R6, R6b, R10, R11, R34, R50;
 * booking-P2): `createSession`, `updateSession`, `publishSession` (`bookings.override`),
 * `setSessionOpen`, `upsertHold`, `deleteHold` (`bookings.write`). `cancelSession` lives in
 * `actions/bookings.ts`. Capacity and hold changes run under the session row lock and re-read
 * `v_session_availability` (R10); every change that frees capacity enqueues
 * `waitlist.offer_next` in the same transaction (R34). A "use server" file exports async
 * functions only, so the Zod inputs and helpers stay unexported.
 */
import { z } from "zod";
import { bookings, capacityHolds, sessions } from "@beam/db/schema";
import { BookingConflictError, InvalidTransitionError, SessionFullError, localDateTimeToUtc, sessionTransition } from "@beam/core/booking";
import { LocalizedTextSchema, missingLocales, type LocalizedText } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { NotFoundError, ValidationError, actorHasPermission, and, eq, gt, inArray, or, sql, type Ctx } from "@/lib/ctx";
import { locationOverlaps } from "../queries/schedule";
import { lockSession, readAvailabilityRow, type SessionRow } from "../server/book";

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/);
const EventCategory = z.enum(["lecture", "concert", "member_event", "experience", "webinar", "special_activity", "partner_event"]);

const CreateSessionInput = z.object({
  kind: z.enum(["day", "night", "event"]),
  eventCategory: EventCategory.optional(),
  partnerCompanyId: z.uuid().optional(),
  title: LocalizedTextSchema,
  description: LocalizedTextSchema.optional(),
  startsAt: localDateTime,
  durationMinutes: z.number().int().min(15).max(2880),
  capacitySeats: z.number().int().min(0).optional(),
  capacityBeds: z.number().int().min(0).optional(),
  creditKind: z.enum(["day", "night"]).nullish(),
  creditCost: z.number().int().min(0).max(10).default(1),
  productId: z.uuid().optional(),
  isMemberOnly: z.boolean().optional(),
  location: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(5000).optional(),
  claimWindowMinutes: z.number().int().min(10).max(2880).optional(),
  publish: z.boolean().default(false),
});

const UpdateSessionInput = z.object({
  id: z.uuid(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
  eventCategory: EventCategory.optional(),
  partnerCompanyId: z.uuid().nullish(),
  title: LocalizedTextSchema.optional(),
  description: LocalizedTextSchema.nullish(),
  startsAt: localDateTime.optional(),
  durationMinutes: z.number().int().min(15).max(2880).optional(),
  capacitySeats: z.number().int().min(0).optional(),
  capacityBeds: z.number().int().min(0).optional(),
  creditKind: z.enum(["day", "night"]).nullish(),
  creditCost: z.number().int().min(0).max(10).optional(),
  productId: z.uuid().nullish(),
  isMemberOnly: z.boolean().optional(),
  location: z.string().trim().max(200).nullish(),
  notes: z.string().trim().max(5000).nullish(),
  claimWindowMinutes: z.number().int().min(10).max(2880).optional(),
});

const IdInput = z.object({ id: z.uuid() });
const SetOpenInput = z.object({ id: z.uuid(), open: z.boolean() });

const HoldInput = z.object({
  id: z.uuid().optional(),
  sessionId: z.uuid(),
  kind: z.enum(["staff", "partner", "host", "speaker", "blocked"]),
  quantity: z.number().int().min(1).max(10_000),
  companyId: z.uuid().nullish(),
  note: z.string().trim().max(2000).nullish(),
});

export type SessionWarning = { code: "location_overlap"; sessionId: string };

const isFilled = (text: LocalizedText | null | undefined) => !!text && Object.values(text).some((v) => typeof v === "string" && v.trim().length > 0);

/** Section 8 / R50: title complete, description complete when it has text (`validation` per locale). */
function assertPublishable(title: LocalizedText, description: LocalizedText | null | undefined): void {
  const fields: Record<string, string> = {};
  for (const l of missingLocales(title)) fields[`title.${l}`] = "missing";
  if (isFilled(description)) for (const l of missingLocales(description)) fields[`description.${l}`] = "missing";
  if (Object.keys(fields).length) throw new ValidationError("missing_translation", fields);
}

/** R50 and the `sessions` checks, as `validation` fields instead of a database error. */
function assertSessionShape(v: { kind: string; eventCategory: string | null; partnerCompanyId: string | null; capacitySeats: number | null; capacityBeds: number | null }): void {
  const fields: Record<string, string> = {};
  if (v.kind === "event" && !v.eventCategory) fields.eventCategory = "required";
  if (v.kind !== "event" && v.eventCategory) fields.eventCategory = "events_only";
  if (v.eventCategory === "partner_event" && !v.partnerCompanyId) fields.partnerCompanyId = "required";
  if (v.kind === "night" && v.capacityBeds == null) fields.capacityBeds = "required";
  if (v.kind !== "night" && v.capacityBeds != null) fields.capacityBeds = "night_only";
  if (v.kind !== "night" && v.capacitySeats == null) fields.capacitySeats = "required";
  if (Object.keys(fields).length) throw new ValidationError("validation", fields);
}

/** R34: `waitlist.offer_next` for the session, keyed by what freed the capacity. */
async function offerNext(ctx: Ctx, sessionId: string, trigger: string): Promise<void> {
  await ctx.enqueue({ kind: "waitlist.offer_next", payload: { sessionId, trigger }, key: `waitlist:${sessionId}:offer_next:${trigger}` });
}

/** `<minute>` trigger of the offer key (spec 4.5), from the request clock. */
const minuteOf = (d: Date) => d.toISOString().slice(0, 16);

const capacityOf = (s: Pick<SessionRow, "capacityBeds" | "capacitySeats">) => s.capacityBeds ?? s.capacitySeats ?? 0;

async function overlapWarnings(ctx: Ctx, s: Pick<SessionRow, "id" | "location" | "startsAt" | "endsAt">): Promise<SessionWarning[]> {
  const ids = await locationOverlaps(ctx.tx, s.location, [{ startsAt: s.startsAt, endsAt: s.endsAt }], { excludeSessionIds: [s.id] });
  return ids.map((sessionId) => ({ code: "location_overlap" as const, sessionId }));
}

/** R5, R50: a one-off session or event (draft unless `publish`), never touched by materialisation. */
export const createSession = action(
  { name: "booking.create_session", audience: "staff", permission: "bookings.override", input: CreateSessionInput, audit: { entityType: "session", entityId: (_i, o: { sessionId: string; warnings: SessionWarning[] }) => o.sessionId } },
  async (ctx, input): Promise<{ sessionId: string; warnings: SessionWarning[] }> => {
    const eventCategory = input.eventCategory ?? null;
    const values = {
      kind: input.kind,
      eventCategory,
      partnerCompanyId: input.partnerCompanyId ?? null,
      capacitySeats: input.capacitySeats ?? null,
      capacityBeds: input.capacityBeds ?? null,
    };
    assertSessionShape(values);
    const description = isFilled(input.description) ? input.description! : null;
    if (input.publish) assertPublishable(input.title, description);
    const startsAt = localDateTimeToUtc(input.startsAt);
    const [row] = await ctx.tx
      .insert(sessions)
      .values({
        ...values,
        title: input.title,
        description,
        startsAt,
        endsAt: new Date(startsAt.getTime() + input.durationMinutes * 60_000),
        creditKind: input.creditKind ?? null,
        creditCost: input.creditCost,
        productId: input.productId ?? null,
        // R50: a member event is for members unless staff say otherwise.
        isMemberOnly: input.isMemberOnly ?? eventCategory === "member_event",
        location: input.location || null,
        notes: input.notes || null,
        ...(input.claimWindowMinutes ? { claimWindowMinutes: input.claimWindowMinutes } : {}),
        publishedAt: input.publish ? ctx.now : null,
        hasManualChanges: true,
      })
      .returning();
    return { sessionId: row!.id, warnings: await overlapWarnings(ctx, row!) };
  },
);

/**
 * R6: edits one session (marks it `has_manual_changes`). Capacity may drop only to
 * `held + booked + live offers` (`capacity_below_bookings`); raising it enqueues
 * `waitlist.offer_next`. `expectedUpdatedAt` guards against a concurrent edit (`stale_version`).
 */
export const updateSession = action(
  { name: "booking.update_session", audience: "staff", permission: "bookings.override", input: UpdateSessionInput, audit: { entityType: "session", entityId: (i) => i.id } },
  async (ctx, input): Promise<{ id: string; warnings: SessionWarning[] }> => {
    const current = await lockSession(ctx.tx, input.id);
    if (current.updatedAt.getTime() !== new Date(input.expectedUpdatedAt).getTime()) throw new BookingConflictError("stale_version");
    if (current.status === "cancelled") throw new InvalidTransitionError("cancelled", "cancelled", { entity: "session", reason: "cancelled_session_is_read_only" });
    const startsAt = input.startsAt ? localDateTimeToUtc(input.startsAt) : current.startsAt;
    const duration = input.durationMinutes ?? Math.round((current.endsAt.getTime() - current.startsAt.getTime()) / 60_000);
    const next = {
      eventCategory: input.eventCategory ?? current.eventCategory,
      partnerCompanyId: input.partnerCompanyId === undefined ? current.partnerCompanyId : input.partnerCompanyId,
      title: (input.title ?? current.title) as LocalizedText,
      description: input.description === undefined ? (current.description) : isFilled(input.description) ? input.description : null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + duration * 60_000),
      capacitySeats: input.capacitySeats ?? current.capacitySeats,
      capacityBeds: input.capacityBeds ?? current.capacityBeds,
      creditKind: input.creditKind === undefined ? current.creditKind : input.creditKind,
      creditCost: input.creditCost ?? current.creditCost,
      productId: input.productId === undefined ? current.productId : input.productId,
      isMemberOnly: input.isMemberOnly ?? current.isMemberOnly,
      location: input.location === undefined ? current.location : input.location || null,
      notes: input.notes === undefined ? current.notes : input.notes || null,
      claimWindowMinutes: input.claimWindowMinutes ?? current.claimWindowMinutes,
    };
    assertSessionShape({ kind: current.kind, ...next });
    if (current.publishedAt) assertPublishable(next.title, next.description);

    const before = capacityOf(current);
    const after = capacityOf(next);
    if (after < before) {
      const a = await readAvailabilityRow(ctx.tx, current);
      const used = a.held + a.booked + a.liveOffers;
      if (after < used) throw new BookingConflictError("capacity_below_bookings", { capacity: after, used });
      if (current.leadReservedSeats > after) throw new BookingConflictError("capacity_below_bookings", { capacity: after, leadReservedSeats: current.leadReservedSeats });
    }
    const [row] = await ctx.tx
      .update(sessions)
      .set({ ...next, hasManualChanges: true, updatedAt: sql`now()` })
      .where(eq(sessions.id, current.id))
      .returning();
    if (after > before) await offerNext(ctx, current.id, `capacity:${after}:${minuteOf(ctx.now)}`);
    return { id: row!.id, warnings: await overlapWarnings(ctx, row!) };
  },
);

/** R50: publishes a draft session or event (complete title; an event needs its category). */
export const publishSession = action(
  { name: "booking.publish_session", audience: "staff", permission: "bookings.override", input: IdInput, audit: { entityType: "session", entityId: (i) => i.id } },
  async (ctx, input): Promise<{ publishedAt: Date }> => {
    const current = await lockSession(ctx.tx, input.id);
    if (current.status === "cancelled") throw new InvalidTransitionError("cancelled", "open", { entity: "session", reason: "cancelled_session_is_read_only" });
    if (current.publishedAt) return { publishedAt: current.publishedAt };
    assertPublishable(current.title, current.description);
    assertSessionShape(current);
    const [row] = await ctx.tx.update(sessions).set({ publishedAt: ctx.now, updatedAt: sql`now()` }).where(eq(sessions.id, current.id)).returning();
    return { publishedAt: row!.publishedAt! };
  },
);

/** `open <-> closed` (`sessionTransition`); reopening frees capacity for the waitlist (R34). */
export const setSessionOpen = action(
  { name: "booking.set_session_open", audience: "staff", permission: "bookings.write", input: SetOpenInput, audit: { entityType: "session", entityId: (i) => i.id } },
  async (ctx, input): Promise<{ status: "open" | "closed" | "cancelled" }> => {
    const current = await lockSession(ctx.tx, input.id);
    const to = input.open ? "open" : "closed";
    if (current.status === to) return { status: current.status };
    sessionTransition(current.status, to);
    const [row] = await ctx.tx.update(sessions).set({ status: to, updatedAt: sql`now()` }).where(eq(sessions.id, current.id)).returning();
    if (to === "open") await offerNext(ctx, current.id, `reopen:${minuteOf(ctx.now)}`);
    return { status: row!.status };
  },
);

/** Live bookings filling a hold (R11): the statuses `v_session_availability` counts as booked. */
async function holdBookings(ctx: Ctx, holdId: string): Promise<number> {
  const [row] = await ctx.tx
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(
      and(
        eq(bookings.capacityHoldId, holdId),
        or(inArray(bookings.status, ["confirmed", "attended", "no_show"]), and(eq(bookings.status, "reserved"), gt(bookings.reservedUntil, ctx.now))),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * R10, R11: creates or edits a capacity hold under the session lock. A hold never holds fewer
 * places than its live bookings (`capacity_below_bookings`); growing it needs free capacity
 * (`session_full`) unless the actor has `bookings.override`. A smaller hold enqueues
 * `waitlist.offer_next`.
 */
export const upsertHold = action(
  { name: "booking.upsert_hold", audience: "staff", permission: "bookings.write", input: HoldInput, audit: { entityType: "capacity_hold", entityId: (_i, o: { id: string }) => o.id } },
  async (ctx, input): Promise<{ id: string }> => {
    if (input.kind === "partner" && !input.companyId) throw new ValidationError("validation", { companyId: "required" });
    const session = await lockSession(ctx.tx, input.sessionId);
    if (session.status === "cancelled") throw new InvalidTransitionError("cancelled", "cancelled", { entity: "session", reason: "cancelled_session_is_read_only" });
    const values = { kind: input.kind, quantity: input.quantity, companyId: input.companyId ?? null, note: input.note || null };
    let previous = 0;
    let id: string;
    if (input.id) {
      const [hold] = await ctx.tx.select().from(capacityHolds).where(eq(capacityHolds.id, input.id)).for("update");
      if (!hold || hold.sessionId !== session.id) throw new NotFoundError("hold_not_found");
      const used = await holdBookings(ctx, hold.id);
      if (input.quantity < used) throw new BookingConflictError("capacity_below_bookings", { quantity: input.quantity, used });
      previous = hold.quantity;
      id = hold.id;
    } else id = "";
    const growth = input.quantity - previous;
    if (growth > 0 && !actorHasPermission(ctx.actor, "bookings.override")) {
      const a = await readAvailabilityRow(ctx.tx, session);
      if (growth > a.availableTotal) throw new SessionFullError({ requested: growth, available: a.availableTotal });
    }
    if (input.id) {
      await ctx.tx.update(capacityHolds).set({ ...values, updatedAt: sql`now()` }).where(eq(capacityHolds.id, id));
      if (growth < 0) await offerNext(ctx, session.id, `${id}:${input.quantity}`);
    } else {
      const [row] = await ctx.tx
        .insert(capacityHolds)
        .values({ ...values, sessionId: session.id, createdByUserId: ctx.actor.kind === "staff" ? ctx.actor.userId : null })
        .returning({ id: capacityHolds.id });
      id = row!.id;
    }
    return { id };
  },
);

/** R11, R34: deletes a hold without live bookings and offers its places to the waitlist. */
export const deleteHold = action(
  { name: "booking.delete_hold", audience: "staff", permission: "bookings.write", input: IdInput, audit: { entityType: "capacity_hold", entityId: (i) => i.id } },
  async (ctx, input): Promise<{ id: string }> => {
    const [found] = await ctx.tx.select({ sessionId: capacityHolds.sessionId }).from(capacityHolds).where(eq(capacityHolds.id, input.id));
    if (!found) throw new NotFoundError("hold_not_found");
    await lockSession(ctx.tx, found.sessionId);
    const used = await holdBookings(ctx, input.id);
    if (used > 0) throw new BookingConflictError("capacity_below_bookings", { quantity: 0, used });
    // Ended rows (cancelled, expired reservations) keep their history without the hold.
    await ctx.tx.update(bookings).set({ capacityHoldId: null, version: sql`${bookings.version} + 1`, updatedAt: sql`now()` }).where(eq(bookings.capacityHoldId, input.id));
    await ctx.tx.delete(capacityHolds).where(eq(capacityHolds.id, input.id));
    await offerNext(ctx, found.sessionId, input.id);
    return { id: input.id };
  },
);

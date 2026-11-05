"use server";
/**
 * booking server actions, area `tickets` (booking spec 4.2, R50-R52; booking-P8, R2 behind
 * `ff_booking_ticket_types`): `upsertTicketType` adds or edits a ticket type of an event (product
 * of kind `ticket`, whose public and member prices are commerce's `price_versions`; an optional
 * capacity of its own inside the session capacity; member-only; a sales window as
 * Europe/Brussels wall clock or an ISO instant; owner plus guests per booking; guest details),
 * `archiveTicketType` takes one off sale (rows already booked keep it). Both run under the
 * session row lock, need `bookings.override` and are audited by the `action()` wrapper. On a
 * published event a type name must be complete in all three locales (R50). A "use server" file
 * exports async functions only, so the Zod inputs and helpers stay unexported.
 */
import { z } from "zod";
import { products, ticketTypes } from "@beam/db/schema";
import { BookingConflictError, InvalidTransitionError, localDateTimeToUtc } from "@beam/core/booking";
import { ForbiddenError } from "@beam/core/errors";
import { LocalizedTextSchema, missingLocales } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { NotFoundError, ValidationError, and, eq, type Ctx } from "@/lib/ctx";
import { flag } from "@/lib/flags";
import { lockSession, ticketTypeSold, type SessionRow } from "../server/book";

const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
/** A Brussels wall-clock time (`2027-03-01T10:00`) or an ISO instant with offset. */
const When = z.union([z.string().regex(LOCAL), z.iso.datetime({ offset: true })]);

const UpsertTicketTypeInput = z.object({
  id: z.uuid().optional(),
  sessionId: z.uuid(),
  productId: z.uuid(),
  name: LocalizedTextSchema,
  capacity: z.number().int().min(1).max(100_000).nullish(),
  isMemberOnly: z.boolean().default(false),
  salesStartAt: When.nullish(),
  salesEndAt: When.nullish(),
  maxPerBooking: z.number().int().min(1).max(20).default(4),
  requiresGuestDetails: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});

const ArchiveTicketTypeInput = z.object({ id: z.uuid() });

function instant(value: string, field: string): Date {
  try {
    const d = LOCAL.test(value) ? localDateTimeToUtc(value) : new Date(value);
    if (Number.isNaN(d.getTime())) throw new RangeError(value);
    return d;
  } catch {
    throw new ValidationError("invalid_time", { [field]: "invalid" });
  }
}

async function assertFlag(ctx: Ctx): Promise<void> {
  if (!(await flag("ff_booking_ticket_types", ctx.actor))) throw new ForbiddenError("forbidden: ff_booking_ticket_types");
}

/** R51: ticket types belong to events that can still be sold (not cancelled, not webinars). */
function assertTicketSession(session: SessionRow): void {
  if (session.status === "cancelled") throw new InvalidTransitionError("cancelled", "cancelled", { entity: "session", reason: "cancelled_session_is_read_only" });
  if (session.webinarId) throw new ValidationError("webinar_session", { sessionId: "webinar_session" });
  if (session.kind !== "event") throw new ValidationError("ticket_types_need_event", { sessionId: "not_an_event" });
}

/** R50-R52 (`booking.upsert_ticket_type`): creates or updates one ticket type of an event. */
export const upsertTicketType = action(
  {
    name: "booking.upsert_ticket_type",
    audience: "staff",
    permission: "bookings.override",
    input: UpsertTicketTypeInput,
    audit: { entityType: "ticket_type", entityId: (i, o: { id: string }) => o?.id ?? i.id ?? null },
  },
  async (ctx, input): Promise<{ id: string }> => {
    await assertFlag(ctx);
    const session = await lockSession(ctx.tx, input.sessionId);
    assertTicketSession(session);

    const fields: Record<string, string> = {};
    if (!Object.values(input.name).some((v) => typeof v === "string" && v.trim())) fields.name = "required";
    // R50: a published event never shows a ticket name missing in one language.
    if (session.publishedAt) for (const l of missingLocales(input.name)) fields[`name.${l}`] = "missing";
    const salesStartAt = input.salesStartAt ? instant(input.salesStartAt, "salesStartAt") : null;
    const salesEndAt = input.salesEndAt ? instant(input.salesEndAt, "salesEndAt") : null;
    if (salesStartAt && salesEndAt && salesEndAt.getTime() <= salesStartAt.getTime()) fields.salesEndAt = "before_start";
    if (salesEndAt && salesEndAt.getTime() > session.endsAt.getTime()) fields.salesEndAt = "after_session_end";
    if (salesStartAt && salesStartAt.getTime() >= session.endsAt.getTime()) fields.salesStartAt = "after_session_end";
    const sessionCapacity = session.capacitySeats ?? session.capacityBeds;
    if (input.capacity != null && sessionCapacity != null && input.capacity > sessionCapacity) fields.capacity = "above_session_capacity";
    if (Object.keys(fields).length) {
      throw new ValidationError(Object.keys(fields).some((k) => k.startsWith("name.")) ? "missing_translation" : "invalid_ticket_type", fields);
    }

    const [product] = await ctx.tx.select({ id: products.id, kind: products.kind, isActive: products.isActive }).from(products).where(eq(products.id, input.productId));
    if (!product) throw new NotFoundError("product_not_found");
    if (product.kind !== "ticket") throw new ValidationError("product_not_ticket", { productId: "not_a_ticket" });
    if (!product.isActive) throw new ValidationError("product_inactive", { productId: "inactive" });

    const values = {
      productId: input.productId,
      name: input.name,
      capacity: input.capacity ?? null,
      isMemberOnly: input.isMemberOnly,
      salesStartAt,
      salesEndAt,
      maxPerBooking: input.maxPerBooking,
      requiresGuestDetails: input.requiresGuestDetails,
      sortOrder: input.sortOrder,
    };

    if (!input.id) {
      const [row] = await ctx.tx
        .insert(ticketTypes)
        .values({ ...values, sessionId: session.id })
        .returning({ id: ticketTypes.id });
      return { id: row!.id };
    }

    const [current] = await ctx.tx.select().from(ticketTypes).where(and(eq(ticketTypes.id, input.id), eq(ticketTypes.sessionId, session.id))).for("update");
    if (!current) throw new NotFoundError("ticket_type_not_found");
    // Capacity never drops below the rows already sold of this type (under the session lock).
    if (values.capacity !== null) {
      const sold = await ticketTypeSold(ctx.tx, current.id, ctx.now);
      if (values.capacity < sold) throw new BookingConflictError("capacity_below_bookings", { sold });
    }
    await ctx.tx
      .update(ticketTypes)
      .set({ ...values, updatedAt: ctx.now })
      .where(eq(ticketTypes.id, current.id));
    return { id: current.id };
  },
);

/** R51 (`booking.archive_ticket_type`): takes a ticket type off sale; idempotent. */
export const archiveTicketType = action(
  {
    name: "booking.archive_ticket_type",
    audience: "staff",
    permission: "bookings.override",
    input: ArchiveTicketTypeInput,
    audit: { entityType: "ticket_type", entityId: (i) => i.id },
  },
  async (ctx, input): Promise<{ id: string }> => {
    await assertFlag(ctx);
    const [found] = await ctx.tx.select({ sessionId: ticketTypes.sessionId }).from(ticketTypes).where(eq(ticketTypes.id, input.id));
    if (!found) throw new NotFoundError("ticket_type_not_found");
    await lockSession(ctx.tx, found.sessionId);
    await ctx.tx
      .update(ticketTypes)
      .set({ isActive: false, updatedAt: ctx.now })
      .where(and(eq(ticketTypes.id, input.id), eq(ticketTypes.isActive, true)));
    return { id: input.id };
  },
);

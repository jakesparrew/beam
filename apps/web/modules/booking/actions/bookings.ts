"use server";
/**
 * booking server actions, area `bookings` (booking spec 4.2). booking-P3a: `bookSession`
 * (customer) and `createManualBooking` (staff) over `bookSeats`; booking-P3b adds the cancel,
 * reschedule, guest and `cancelSession` actions here. Every action goes through `action()` from
 * `@/lib/action`; a "use server" file exports async functions only, so Zod inputs stay
 * unexported.
 */
import { z } from "zod";
import { ForbiddenError } from "@beam/core/errors";
import { action } from "@/lib/action";
import { actorHasPermission, ValidationError } from "@/lib/ctx";
import { bookSeats, type BookResult } from "../server/book";

const EmergencyContact = z.object({ name: z.string().trim().min(1).max(200), phone: z.string().trim().min(3).max(40), relation: z.string().trim().max(100).optional() });

const Guest = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  email: z.email().max(320).optional(),
  sharesBed: z.boolean().optional(),
  payWith: z.enum(["guest", "order"]),
});

const BookSessionInput = z.object({
  sessionId: z.uuid(),
  ticketTypeId: z.uuid().optional(),
  payWith: z.enum(["credit", "order", "guest", "free"]),
  grantOwnerPersonId: z.uuid().optional(),
  guests: z.array(Guest).max(10).default([]),
  promoCode: z.string().trim().max(64).optional(),
  useEuroCredit: z.boolean().optional(),
  acceptTerms: z.boolean().optional(),
  emergencyContact: EmergencyContact.optional(),
  clientKey: z.uuid(),
});

/** Customer booking from the portal (R16-R18, R54-R56, R62, R62b). */
export const bookSession = action(
  { name: "booking.book", audience: "customer", input: BookSessionInput },
  async (ctx, input): Promise<{ kind: "confirmed"; bookingIds: string[] } | { kind: "checkout"; orderId: string; redirectTo: string }> => {
    if (ctx.actor.kind !== "customer") throw new ForbiddenError("forbidden: customer");
    const result: BookResult = await bookSeats(ctx.tx, ctx, { ...input, personId: ctx.actor.personId, source: "portal", by: "customer", locale: ctx.locale });
    return result.kind === "checkout" ? { kind: "checkout", orderId: result.orderId, redirectTo: result.redirectTo } : { kind: "confirmed", bookingIds: result.bookingIds };
  },
);

const ManualGuest = Guest.extend({ payWith: z.enum(["guest", "order", "free"]) });

const ManualBookingInput = z.object({
  sessionId: z.uuid(),
  personId: z.uuid(),
  ticketTypeId: z.uuid().optional(),
  payWith: z.enum(["credit", "order", "guest", "free"]),
  grantOwnerPersonId: z.uuid().optional(),
  payAtDesk: z.boolean().optional(),
  holdId: z.uuid().optional(),
  overCapacity: z.boolean().optional(),
  reason: z.string().trim().max(500).optional(),
  guests: z.array(ManualGuest).max(10).default([]),
  emergencyContact: EmergencyContact.optional(),
  sendEmail: z.boolean().default(true),
  clientKey: z.uuid(),
});

/**
 * Staff booking (`bookings.write`; `bookings.override` for free, over-capacity and member-only
 * bypass, R12, R15, R16). Order-paid manual bookings create an `admin` channel order that staff
 * settle at `/admin/pos?order=<orderId>` (R63 pay at desk).
 */
export const createManualBooking = action(
  {
    name: "booking.create_manual",
    audience: "staff",
    permission: "bookings.write",
    input: ManualBookingInput,
    audit: { entityType: "booking", entityId: (_i, o: { bookingIds: string[] }) => o.bookingIds[0] ?? null, personId: (i) => i.personId },
  },
  async (ctx, input): Promise<{ bookingIds: string[]; orderId?: string }> => {
    // Free bookings of paid sessions and the member-only bypass are checked by `bookSeats` (R15, R16).
    if (input.overCapacity && !actorHasPermission(ctx.actor, "bookings.override")) throw new ForbiddenError("forbidden: bookings.override", "bookings.override");
    if (input.overCapacity && !input.reason) throw new ValidationError("reason_required", { reason: "required" });
    const result = await bookSeats(ctx.tx, ctx, { ...input, source: "admin", by: "staff" });
    return result.kind === "checkout" ? { bookingIds: result.bookingIds, orderId: result.orderId } : { bookingIds: result.bookingIds };
  },
);

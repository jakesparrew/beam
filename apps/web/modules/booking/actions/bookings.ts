"use server";
/**
 * booking server actions, area `bookings` (booking spec 4.2). booking-P3a: `bookSession`
 * (customer) and `createManualBooking` (staff) over `bookSeats`; booking-P3b the cancel,
 * reschedule, guest and `cancelSession` actions over `../server/{cancel,reschedule,guests}.ts`. Every action goes through `action()` from
 * `@/lib/action`; a "use server" file exports async functions only, so Zod inputs stay
 * unexported.
 */
import { z } from "zod";
import { ForbiddenError } from "@beam/core/errors";
import { action } from "@/lib/action";
import { actorHasPermission, ValidationError } from "@/lib/ctx";
import { bookSeats, type BookResult } from "../server/book";
import { cancelBookingRow, cancelSessionRow } from "../server/cancel";
import { addGuestRow, type AddGuestResult } from "../server/guests";
import { rescheduleRow } from "../server/reschedule";

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

// ---------------------------------------------------------------------------
// booking-P3b: cancel, reschedule, guests, session cancellation
// ---------------------------------------------------------------------------

type CancelOutput = { status: "cancelled" | "late_cancelled"; creditReleased: boolean; refundRequested: boolean };

const CancelMineInput = z.object({ bookingId: z.uuid(), expectedVersion: z.number().int().min(1), includeGuests: z.boolean().default(true) });

/** Customer: own `confirmed` rows or own guest rows, by the policy (R27b-R30). */
export const cancelMyBooking = action(
  { name: "booking.cancel_mine", audience: "customer", input: CancelMineInput },
  async (ctx, input): Promise<CancelOutput> => {
    const r = await cancelBookingRow(ctx.tx, ctx, { ...input, by: "customer" });
    return { status: r.status, creditReleased: r.creditReleased, refundRequested: r.refundRequested };
  },
);

const CancelInput = z.object({
  bookingId: z.uuid(),
  expectedVersion: z.number().int().min(1),
  includeGuests: z.boolean().default(true),
  reason: z.string().trim().min(1).max(500),
  force: z.enum(["release_credit", "refund"]).optional(),
});

/** Staff (`bookings.write`): the policy result; `force` needs `bookings.override` (R32). */
export const cancelBooking = action(
  {
    name: "booking.cancel",
    audience: "staff",
    permission: "bookings.write",
    input: CancelInput,
    audit: { entityType: "booking", entityId: (i) => i.bookingId },
  },
  async (ctx, input): Promise<CancelOutput> => {
    if (input.force) ctx.require("bookings.override");
    const r = await cancelBookingRow(ctx.tx, ctx, { ...input, by: "staff" });
    return { status: r.status, creditReleased: r.creditReleased, refundRequested: r.refundRequested };
  },
);

const CancelSessionInput = z.object({ id: z.uuid(), reason: z.string().trim().min(3).max(500), notify: z.boolean().default(true) });

/** BEAM cancels a session (`bookings.override`, R33); above 50 live bookings the rest runs in `sessions.cancel_bookings`. */
export const cancelSession = action(
  {
    name: "booking.cancel_session",
    audience: "staff",
    permission: "bookings.override",
    input: CancelSessionInput,
    audit: { entityType: "session", entityId: (i) => i.id },
  },
  async (ctx, input): Promise<{ cancelledBookings: number; refundsRequested: number; releasedEntries: number; queuedBookings: number }> => {
    const r = await cancelSessionRow(ctx.tx, ctx, { sessionId: input.id, reason: input.reason, notify: input.notify });
    return { cancelledBookings: r.cancelledBookings, refundsRequested: r.refundsRequested, releasedEntries: r.releasedEntries, queuedBookings: r.queuedBookings };
  },
);

const RescheduleMineInput = z.object({ bookingId: z.uuid(), expectedVersion: z.number().int().min(1), targetSessionId: z.uuid() });

/** Customer reschedule inside the free window, same kind and product, chain limit (R31). */
export const rescheduleMyBooking = action(
  { name: "booking.reschedule_mine", audience: "customer", input: RescheduleMineInput },
  async (ctx, input): Promise<{ newBookingId: string }> => {
    const r = await rescheduleRow(ctx.tx, ctx, { ...input, by: "customer" });
    return { newBookingId: r.newBookingId };
  },
);

const RescheduleInput = RescheduleMineInput.extend({ reason: z.string().trim().min(1).max(500) });

/** Staff (`bookings.write`) may move outside the window; across products needs `bookings.override` (R31). */
export const rescheduleBooking = action(
  {
    name: "booking.reschedule",
    audience: "staff",
    permission: "bookings.write",
    input: RescheduleInput,
    audit: { entityType: "booking", entityId: (i) => i.bookingId },
  },
  async (ctx, input): Promise<{ newBookingId: string }> => {
    const r = await rescheduleRow(ctx.tx, ctx, { ...input, by: "staff" });
    return { newBookingId: r.newBookingId };
  },
);

type GuestOutput = { bookingId: string } | { kind: "checkout"; orderId: string; redirectTo: string };
const guestOutput = (r: AddGuestResult): GuestOutput =>
  r.kind === "checkout" ? { kind: "checkout", orderId: r.orderId, redirectTo: r.redirectTo } : { bookingId: r.bookingId };

const AddMyGuestInput = z.object({ ownerBookingId: z.uuid(), guest: Guest, clientKey: z.uuid().optional() });

/** Customer adds a guest to their own booking (R54-R56). */
export const addMyGuest = action(
  { name: "booking.add_guest_mine", audience: "customer", input: AddMyGuestInput },
  async (ctx, input): Promise<GuestOutput> => guestOutput(await addGuestRow(ctx.tx, ctx, { ...input, by: "customer", locale: ctx.locale })),
);

const AddGuestInput = z.object({ ownerBookingId: z.uuid(), guest: ManualGuest, reason: z.string().trim().max(500).optional(), clientKey: z.uuid().optional() });

/** Staff adds a guest (`bookings.write`; a free guest of a paid session needs `bookings.override`). */
export const addGuest = action(
  {
    name: "booking.add_guest",
    audience: "staff",
    permission: "bookings.write",
    input: AddGuestInput,
    audit: { entityType: "booking", entityId: (i) => i.ownerBookingId },
  },
  async (ctx, input): Promise<GuestOutput> => guestOutput(await addGuestRow(ctx.tx, ctx, { ...input, by: "staff" })),
);

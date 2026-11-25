/**
 * Children on a booking (owner's requirements review, sections 1.1 and 1.2). A child is a guest
 * row of an adult's booking (`bookings.guest_of_booking_id`), so a child never books alone; it
 * takes a seat like any other guest. Under 12 is free, 12 to 17 pays half (the youth products).
 * Night sessions take children; day sessions only on Saturday in the 13:00 session.
 */
import { brusselsDate, brusselsTime, isoWeekday } from "./schedule";

/** `child` = under 12 (free), `youth` = 12 to 17 (half price). */
export const AGE_GROUPS = ["child", "youth"] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

/** The product a child seat is sold as, per session kind and age group. */
export const CHILD_PRODUCT_SKUS = {
  day: { child: "BEAM-DAY-CHILD", youth: "BEAM-DAY-YOUTH" },
  night: { child: "BEAM-NIGHT-CHILD", youth: "BEAM-NIGHT-YOUTH" },
} as const;

/** Whether a session takes children: every night session, and the Saturday 13:00 day session. */
export function childrenAllowed(session: { kind: string; startsAt: Date }): boolean {
  if (session.kind === "night") return true;
  if (session.kind !== "day") return false;
  return isoWeekday(brusselsDate(session.startsAt)) === 6 && brusselsTime(session.startsAt) === "13:00";
}

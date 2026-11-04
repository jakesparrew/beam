/**
 * webinar timeline events (`defineEvent`, webinar spec section 4.1). Facade read by
 * `pnpm gen:indexes`: every `kind` is a literal. Every native event has subject `person`,
 * `ref = { type: 'webinar_registration', id }` and is not sensitive.
 *
 * webinar-P2 declares the lifecycle facts it writes: `webinar.cancelled` and
 * `webinar.rescheduled` per registration, and the fresh `webinar.registered` (with
 * `rescheduled: true`) a reschedule writes so the reminder journey re-enrols (edge case 9).
 * webinar-P3 registers people and keeps `webinar.registered`; later packages add the watch,
 * interaction and no-show facts.
 */
import { z } from "zod";
import { WATCH_MODES, WEBINAR_MODES } from "@beam/core/webinar";
import { defineEvent } from "@/lib/events";

/** An instant: a `Date` or an ISO string, stored as ISO text. */
const instant = z.union([z.date(), z.iso.datetime({ offset: true })]).transform((v) => (typeof v === "string" ? v : v.toISOString()));
const localized = z.record(z.string(), z.string());

/** `webinar.registered` data (section 4.1); `ends_at = starts_at + real or planned duration`, both null on demand. */
export const WebinarRegisteredData = z.object({
  webinar_id: z.uuid(),
  slug: z.string().min(1),
  title: localized,
  webinar_mode: z.enum(WEBINAR_MODES),
  starts_at: instant.nullable(),
  ends_at: instant.nullable(),
  registration_id: z.uuid(),
  session: z.object({ id: z.uuid(), kind: z.literal("event") }).nullable(),
  person_status: z.enum(["lead", "customer", "member"]),
  source: z.enum(["site", "portal", "admin", "automation"]),
  utm: z.record(z.string(), z.string()).default({}),
  rescheduled: z.literal(true).optional(),
});
export type WebinarRegisteredData = z.input<typeof WebinarRegisteredData>;

export const WebinarCancelledData = z.object({ webinar_id: z.uuid(), registration_id: z.uuid(), reason: z.string() });
export type WebinarCancelledData = z.input<typeof WebinarCancelledData>;

export const WebinarRescheduledData = z.object({
  webinar_id: z.uuid(),
  registration_id: z.uuid(),
  starts_at: instant,
  previous_starts_at: instant.nullable(),
});
export type WebinarRescheduledData = z.input<typeof WebinarRescheduledData>;

/** The mode values an event row may carry (`activity_events.mode`). */
export const EVENT_MODES = WATCH_MODES;

export const events = [
  defineEvent({ kind: "webinar.registered", subject: "person", data: WebinarRegisteredData }),
  defineEvent({ kind: "webinar.cancelled", subject: "person", data: WebinarCancelledData }),
  defineEvent({ kind: "webinar.rescheduled", subject: "person", data: WebinarRescheduledData }),
] as const;

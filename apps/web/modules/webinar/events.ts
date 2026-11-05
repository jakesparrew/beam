/**
 * webinar timeline events (`defineEvent`, webinar spec section 4.1). Facade read by
 * `pnpm gen:indexes`: every `kind` is a literal. Every native event has subject `person`,
 * `ref = { type: 'webinar_registration', id }` and is not sensitive.
 *
 * webinar-P2 declares the lifecycle facts it writes: `webinar.cancelled` and
 * `webinar.rescheduled` per registration, and the fresh `webinar.registered` (with
 * `rescheduled: true`) a reschedule writes so the reminder journey re-enrols (edge case 9).
 * webinar-P3 registers people (`webinar.registered`, also after a re-registration that follows a
 * cancellation) and cancels registrations (`webinar.registration_cancelled`). webinar-P4 adds the
 * watch facts of rules 27-29: `webinar.started` (first view of a mode), `webinar.attended`,
 * `webinar.watched` (`data.threshold`) and `webinar.no_show` (mode `live`, written by finalise);
 * webinar-P5 adds the interaction facts.
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

/** `webinar.registration_cancelled` data: who cancelled (the customer or staff). */
export const WebinarRegistrationCancelledData = z.object({
  webinar_id: z.uuid(),
  registration_id: z.uuid(),
  by: z.enum(["customer", "staff"]),
});
export type WebinarRegistrationCancelledData = z.input<typeof WebinarRegistrationCancelledData>;

/** `webinar.started`: the first view of a registration in a mode (rule 28). */
export const WebinarStartedData = z.object({ webinar_id: z.uuid(), registration_id: z.uuid() });
export type WebinarStartedData = z.input<typeof WebinarStartedData>;

/** `webinar.attended`: `attended_min_sec` reached in the event's mode (rule 27). */
export const WebinarAttendedData = z.object({ webinar_id: z.uuid(), registration_id: z.uuid(), watched_sec: z.number().int().min(0) });
export type WebinarAttendedData = z.input<typeof WebinarAttendedData>;

/** `webinar.watched`: one threshold of rule 27 reached in the event's mode. */
export const WebinarWatchedData = z.object({
  webinar_id: z.uuid(),
  registration_id: z.uuid(),
  threshold: z.enum(["15m", "30m", "50pct", "end"]),
  watched_sec: z.number().int().min(0),
});
export type WebinarWatchedData = z.input<typeof WebinarWatchedData>;

/** `webinar.no_show` (mode `live`): registered for live, no live attendance (rule 29). */
export const WebinarNoShowData = z.object({
  webinar_id: z.uuid(),
  registration_id: z.uuid(),
  replay_available: z.boolean(),
  replay_until_at: instant.nullable(),
});
export type WebinarNoShowData = z.input<typeof WebinarNoShowData>;

/** The mode values an event row may carry (`activity_events.mode`). */
export const EVENT_MODES = WATCH_MODES;

export const events = [
  defineEvent({ kind: "webinar.registered", subject: "person", data: WebinarRegisteredData }),
  defineEvent({ kind: "webinar.registration_cancelled", subject: "person", data: WebinarRegistrationCancelledData }),
  defineEvent({ kind: "webinar.cancelled", subject: "person", data: WebinarCancelledData }),
  defineEvent({ kind: "webinar.rescheduled", subject: "person", data: WebinarRescheduledData }),
  defineEvent({ kind: "webinar.started", subject: "person", data: WebinarStartedData }),
  defineEvent({ kind: "webinar.attended", subject: "person", data: WebinarAttendedData }),
  defineEvent({ kind: "webinar.watched", subject: "person", data: WebinarWatchedData }),
  defineEvent({ kind: "webinar.no_show", subject: "person", data: WebinarNoShowData }),
] as const;

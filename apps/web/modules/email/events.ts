/**
 * email timeline events (`defineEvent`, email spec rule 52 and section 4 "Activity event
 * kinds"). Facade read by `pnpm gen:indexes`. All are person events with
 * `ref = { type: 'email_message', id }`, never sensitive, and `data` keys in snake_case
 * (cross-module convention 2). The subject is never copied (it may contain a name).
 * `email.opened` and `email.clicked` are automation triggers.
 */
import { z } from "zod";
import { defineEvent } from "@/lib/events";

const uuid = z.uuid();

export const events = [
  defineEvent({
    kind: "email.sent",
    subject: "person",
    data: z.object({ template_slug: z.string().min(1), campaign_id: uuid.nullable(), enrolment_id: uuid.nullable() }),
  }),
  defineEvent({ kind: "email.opened", subject: "person", data: z.object({ template_slug: z.string().min(1).optional() }) }),
  defineEvent({ kind: "email.clicked", subject: "person", data: z.object({ link_index: z.number().int().min(0), url: z.string().url() }) }),
  defineEvent({ kind: "email.bounced", subject: "person", data: z.object({ bounce_type: z.enum(["hard", "soft"]) }) }),
  defineEvent({ kind: "email.complained", subject: "person", data: z.object({}) }),
  defineEvent({ kind: "email.blocked", subject: "person", data: z.object({ reason: z.enum(["translation", "suppressed"]) }) }),
] as const;

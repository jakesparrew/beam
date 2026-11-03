/**
 * Platform timeline events (platform spec 4.7). Staff sign-ins are audit rows, not events.
 * Facade read by `pnpm gen:indexes`.
 */
import { z } from "zod";
import { defineEvent } from "@/lib/events";

export const events = [
  defineEvent({
    kind: "platform.account_created",
    subject: "person",
    data: z.object({ user_id: z.string().uuid(), method: z.literal("magic_link") }),
  }),
  defineEvent({
    kind: "platform.signed_in",
    subject: "person",
    data: z.object({ method: z.enum(["magic_link", "password"]) }),
  }),
  defineEvent({
    kind: "platform.password_set",
    subject: "person",
    data: z.object({}),
  }),
];

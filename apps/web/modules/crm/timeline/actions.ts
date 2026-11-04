"use server";
/** Notes and interactions (crm spec 4.1, rule 3.26), implemented by crm-P7. crm-P1 stubs. */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { action } from "@/lib/action";

export const addNote = action(
  {
    name: "crm.add_note",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ personId: z.uuid().optional(), companyId: z.uuid().optional(), body: z.string().trim().min(1).max(10_000), isSensitive: z.boolean() }),
  },
  (): Promise<{ eventId: string }> => Promise.reject(new NotImplementedError("crm.add_note")),
);

export const logInteraction = action(
  {
    name: "crm.log_interaction",
    audience: "staff",
    permission: "persons.write",
    input: z.object({
      personId: z.uuid().optional(),
      companyId: z.uuid().optional(),
      channel: z.enum(["call", "email", "whatsapp", "in_person", "meeting", "other"]),
      purpose: z.enum(["service", "sales_follow_up", "reactivation", "b2b"]),
      summary: z.string().trim().min(1).max(2000),
      occurredAt: z.coerce.date().optional(),
    }),
  },
  (): Promise<{ eventId: string }> => Promise.reject(new NotImplementedError("crm.log_interaction")),
);

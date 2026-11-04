"use server";
/** Sensitive field actions (crm rules 3.23 to 3.26), implemented by crm-P4. crm-P1 stubs. */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { SENSITIVE_FIELD_KEYS, type SensitiveFieldKey } from "@beam/core/privacy";
import { action } from "@/lib/action";

export const setSensitiveField = action(
  {
    name: "crm.set_sensitive_field",
    audience: "staff",
    permission: "persons.sensitive_read",
    input: z.object({ personId: z.uuid(), key: z.enum(SENSITIVE_FIELD_KEYS), value: z.string().min(1).max(5000).nullable() }),
  },
  (): Promise<Record<string, never>> => Promise.reject(new NotImplementedError("crm.set_sensitive_field")),
);

export const revealSensitive = action(
  {
    name: "crm.reveal_sensitive",
    audience: "staff",
    permission: "persons.sensitive_read",
    input: z.object({ personId: z.uuid(), keys: z.array(z.enum(SENSITIVE_FIELD_KEYS)).optional(), eventIds: z.array(z.string().regex(/^[0-9]+$/)).max(50).optional() }),
  },
  (): Promise<{ fields: Partial<Record<SensitiveFieldKey, string>>; notes: { eventId: string; body: string }[] }> =>
    Promise.reject(new NotImplementedError("crm.reveal_sensitive")),
);

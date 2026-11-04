"use server";
/**
 * Customer self-service actions (crm spec 4.1, `audience: 'customer'`, filtered on
 * `ctx.actor.personId`), implemented by crm-P3. crm-P1 stubs; email is not editable here.
 */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import type { MarketingPurpose } from "@beam/core/crm";
import { LOCALES } from "@beam/core/i18n";
import { action } from "@/lib/action";

const todo =
  <O>(name: string) =>
  (): Promise<O> =>
    Promise.reject(new NotImplementedError(name));

export const updateMyProfile = action(
  {
    name: "crm.update_my_profile",
    audience: "customer",
    input: z.object({
      version: z.number().int().positive(),
      firstName: z.string().trim().min(1).max(100),
      lastName: z.string().trim().min(1).max(100),
      phone: z.string().max(40).optional(),
      address: z
        .object({ street: z.string().max(200).optional(), number: z.string().max(20).optional(), box: z.string().max(20).optional(), postal_code: z.string().max(20).optional(), city: z.string().max(100).optional(), country: z.string().length(2) })
        .strict()
        .optional(),
      birthOn: z.iso.date().optional(),
      locale: z.enum(LOCALES),
      preferredChannel: z.enum(["email", "phone", "whatsapp"]).optional(),
      emergencyContact: z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().min(6).max(40), relation: z.string().max(100).optional() }).strict().optional(),
    }),
  },
  todo<{ version: number }>("crm.update_my_profile"),
);

export const updateMyPreferences = action(
  {
    name: "crm.update_my_preferences",
    audience: "customer",
    input: z.object({ newsletter: z.boolean(), events: z.boolean(), member_comms: z.boolean(), b2b: z.boolean(), unsubscribeAll: z.boolean().optional() }),
  },
  todo<{ changed: MarketingPurpose[] }>("crm.update_my_preferences"),
);

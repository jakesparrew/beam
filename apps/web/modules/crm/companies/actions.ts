"use server";
/** Company and contact actions (crm spec 4.1), implemented by crm-P6. crm-P1 stubs. */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { ACQUISITION_SOURCES } from "@beam/core/crm";
import { LOCALES } from "@beam/core/i18n";
import { action } from "@/lib/action";

const todo =
  <O>(name: string) =>
  (): Promise<O> =>
    Promise.reject(new NotImplementedError(name));

const Address = z
  .object({ street: z.string().max(200).optional(), number: z.string().max(20).optional(), box: z.string().max(20).optional(), postal_code: z.string().max(20).optional(), city: z.string().max(100).optional(), country: z.string().length(2) })
  .strict();
const DecisionRole = z.enum(["decision_maker", "influencer", "user", "gatekeeper"]);

export const saveCompany = action(
  {
    name: "crm.save_company",
    audience: "staff",
    permission: "crm.b2b",
    input: z.object({
      id: z.uuid().optional(),
      name: z.string().trim().min(1).max(200),
      vatNumber: z.string().max(30).optional(),
      address: Address.optional(),
      website: z.string().max(300).optional(),
      industry: z.string().max(100).optional(),
      size: z.enum(["1_9", "10_49", "50_249", "250_plus"]).optional(),
      status: z.enum(["target", "prospect", "customer", "partner", "inactive"]),
      ownerUserId: z.uuid().optional(),
      notes: z.string().max(5000).optional(),
      isPartner: z.boolean(),
      partnerCommissionPct: z.number().min(0).max(100).optional(),
    }),
  },
  todo<{ companyId: string }>("crm.save_company"),
);

export const linkContact = action(
  {
    name: "crm.link_contact",
    audience: "staff",
    permission: "crm.b2b",
    input: z.object({
      companyId: z.uuid(),
      personId: z.uuid().optional(),
      newPerson: z
        .object({
          email: z.string().max(254).optional(),
          phone: z.string().max(40).optional(),
          firstName: z.string().max(100).optional(),
          lastName: z.string().max(100).optional(),
          locale: z.enum(LOCALES),
          acquisition: z.object({ source: z.enum(ACQUISITION_SOURCES), campaign: z.string().max(200).optional() }),
        })
        .optional(),
      position: z.string().max(200).optional(),
      decisionRole: DecisionRole.optional(),
      relationship: z.string().max(200).optional(),
      isPrimary: z.boolean(),
    }),
  },
  todo<{ contactId: string }>("crm.link_contact"),
);

const ContactUpdate = z.object({
  contactId: z.uuid(),
  position: z.string().max(200).nullable().optional(),
  decisionRole: DecisionRole.nullable().optional(),
  relationship: z.string().max(200).nullable().optional(),
  isPrimary: z.boolean().optional(),
  endedOn: z.iso.date().optional(),
});

export const updateContact = action({ name: "crm.update_contact", audience: "staff", permission: "crm.b2b", input: ContactUpdate }, todo<{ contactId: string }>("crm.update_contact"));

export const endContact = action(
  { name: "crm.update_contact", audience: "staff", permission: "crm.b2b", input: z.object({ contactId: z.uuid(), endedOn: z.iso.date() }) },
  todo<{ contactId: string }>("crm.update_contact"),
);

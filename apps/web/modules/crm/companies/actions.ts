"use server";
/**
 * Company and contact actions (crm spec 4.1, rule 3.45), crm-P6. Permission `crm.b2b`; linking a
 * new person also needs `persons.write`. Each handler in `./api` writes its own audit row
 * (`company.save`, `company.contact_link`, `company.contact_update`), so the wrapper's row is off.
 */
import { z } from "zod";
import { ACQUISITION_SOURCES } from "@beam/core/crm";
import { LOCALES } from "@beam/core/i18n";
import { action } from "@/lib/action";
import { searchPersons } from "../persons/queries";
import { linkStaffContact, saveStaffCompany, updateStaffContact } from "./api";

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
    audit: false,
  },
  (ctx, input) => saveStaffCompany(ctx, input),
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
    audit: false,
  },
  (ctx, input) => linkStaffContact(ctx, input),
);

const ContactUpdate = z.object({
  contactId: z.uuid(),
  position: z.string().max(200).nullable().optional(),
  decisionRole: DecisionRole.nullable().optional(),
  relationship: z.string().max(200).nullable().optional(),
  isPrimary: z.boolean().optional(),
  endedOn: z.iso.date().optional(),
});

export const updateContact = action({ name: "crm.update_contact", audience: "staff", permission: "crm.b2b", input: ContactUpdate, audit: false }, (ctx, input) =>
  updateStaffContact(ctx, input),
);

/** The "existing person" picker of the link-contact form: up to 8 matches (customer number, email, phone or name). */
export const findContactCandidates = action(
  { name: "crm.find_contact_candidates", audience: "staff", permission: "persons.read", input: z.object({ q: z.string().trim().min(2).max(100) }), audit: false },
  async (ctx, input) => (await searchPersons(ctx.tx, input.q, 8)).map((p) => ({ id: p.id, customerNumber: p.customerNumber, name: p.name })),
);

export const endContact = action(
  { name: "crm.update_contact", audience: "staff", permission: "crm.b2b", input: z.object({ contactId: z.uuid(), endedOn: z.iso.date() }), audit: false },
  (ctx, input) => updateStaffContact(ctx, input),
);

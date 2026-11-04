"use server";
/**
 * Person actions (crm spec 4.1), implemented by crm-P2. crm-P1 stubs with the final names,
 * audiences, permissions and inputs; each handler throws `NotImplementedError`.
 */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { ACQUISITION_SOURCES, PERSON_STATUSES } from "@beam/core/crm";
import { LOCALES } from "@beam/core/i18n";
import { action } from "@/lib/action";

const todo =
  <O>(name: string) =>
  (): Promise<O> =>
    Promise.reject(new NotImplementedError(name));

const Address = z
  .object({
    street: z.string().max(200).optional(),
    number: z.string().max(20).optional(),
    box: z.string().max(20).optional(),
    postal_code: z.string().max(20).optional(),
    city: z.string().max(100).optional(),
    country: z.string().length(2),
  })
  .strict();
const EmergencyContact = z.object({ name: z.string().trim().min(1).max(100), phone: z.string().trim().min(6).max(40), relation: z.string().max(100).optional() }).strict();
const AcquisitionInput = z.object({ source: z.enum(ACQUISITION_SOURCES), campaign: z.string().max(200).optional(), medium: z.string().max(200).optional(), funnel: z.string().max(200).optional() });
const Channel = z.enum(["email", "phone", "whatsapp"]);
const BirthOn = z.iso.date();

export const createPerson = action(
  {
    name: "crm.create_person",
    audience: "staff",
    permission: "persons.write",
    input: z.object({
      email: z.string().max(254).optional(),
      phone: z.string().max(40).optional(),
      firstName: z.string().max(100).optional(),
      lastName: z.string().max(100).optional(),
      locale: z.enum(LOCALES),
      address: Address.optional(),
      birthOn: BirthOn.optional(),
      preferredChannel: Channel.optional(),
      acquisition: AcquisitionInput,
      companyId: z.uuid().optional(),
      confirmDuplicates: z.boolean().optional(),
    }),
  },
  todo<{ personId: string }>("crm.create_person"),
);

export const updatePerson = action(
  {
    name: "crm.update_person",
    audience: "staff",
    permission: "persons.write",
    input: z.object({
      personId: z.uuid(),
      version: z.number().int().positive(),
      patch: z.object({
        email: z.string().max(254).nullable().optional(),
        phone: z.string().max(40).nullable().optional(),
        firstName: z.string().max(100).nullable().optional(),
        lastName: z.string().max(100).nullable().optional(),
        locale: z.enum(LOCALES).optional(),
        address: Address.nullable().optional(),
        birthOn: BirthOn.nullable().optional(),
        preferredChannel: Channel.nullable().optional(),
        linkedinUrl: z.url().max(300).nullable().optional(),
        emergencyContact: EmergencyContact.nullable().optional(),
        externalIds: z.record(z.string(), z.string().max(100)).optional(),
      }),
    }),
  },
  todo<{ version: number }>("crm.update_person"),
);

export const fillAcquisition = action(
  { name: "crm.fill_acquisition", audience: "staff", permission: "persons.write", input: z.object({ personId: z.uuid(), acquisition: AcquisitionInput }) },
  todo<Record<string, never>>("crm.fill_acquisition"),
);

export const setStatusOverride = action(
  {
    name: "crm.set_status_override",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ personId: z.uuid(), status: z.enum(PERSON_STATUSES).nullable(), reason: z.string().trim().min(3).max(500) }),
  },
  todo<{ status: (typeof PERSON_STATUSES)[number] }>("crm.set_status_override"),
);

export const confirmStatusOverride = action(
  { name: "crm.confirm_status_override", audience: "staff", permission: "persons.write", input: z.object({ personId: z.uuid() }) },
  todo<Record<string, never>>("crm.confirm_status_override"),
);

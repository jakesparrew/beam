"use server";
/** Guardian-consent actions (crm rule 3.54, spec 4.1), implemented by crm-P3. crm-P1 stubs. */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { action } from "@/lib/action";

const todo =
  <O>(name: string) =>
  (): Promise<O> =>
    Promise.reject(new NotImplementedError(name));

export const recordDeclaration = action(
  {
    name: "crm.record_declaration",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ personId: z.uuid(), kind: z.literal("guardian_consent"), guardianPersonId: z.uuid() }),
  },
  todo<{ declarationId: string }>("crm.record_declaration"),
);

export const revokeDeclaration = action(
  {
    name: "crm.revoke_declaration",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ personId: z.uuid(), kind: z.literal("guardian_consent"), reason: z.string().trim().min(3).max(500) }),
  },
  todo<{ declarationId: string }>("crm.revoke_declaration"),
);

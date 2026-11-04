"use server";
/** Guardian-consent actions (crm rule 3.54, spec 4.1), crm-P3. Reception records them (method `reception`). */
import { z } from "zod";
import { action } from "@/lib/action";
import { acceptDeclaration, revokeLatestDeclaration } from "./api";

export const recordDeclaration = action(
  {
    name: "crm.record_declaration",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ personId: z.uuid(), kind: z.literal("guardian_consent"), guardianPersonId: z.uuid() }),
    audit: false,
  },
  async (ctx, input): Promise<{ declarationId: string }> => {
    const { declarationId, documentVersion } = await acceptDeclaration(ctx.tx, ctx, {
      personId: input.personId,
      guardianPersonId: input.guardianPersonId,
      method: "reception",
      ip: ctx.ip,
    });
    await ctx.audit({
      action: "declaration.record",
      entityType: "person_declaration",
      entityId: declarationId,
      personId: input.personId,
      newValue: { kind: input.kind, documentVersion, guardianPersonId: input.guardianPersonId },
    });
    return { declarationId };
  },
);

export const revokeDeclaration = action(
  {
    name: "crm.revoke_declaration",
    audience: "staff",
    permission: "persons.write",
    input: z.object({ personId: z.uuid(), kind: z.literal("guardian_consent"), reason: z.string().trim().min(3).max(500) }),
    audit: false,
  },
  async (ctx, input): Promise<{ declarationId: string }> => {
    const { declarationId } = await revokeLatestDeclaration(ctx.tx, ctx, { personId: input.personId, method: "reception" });
    await ctx.audit({
      action: "declaration.revoke",
      entityType: "person_declaration",
      entityId: declarationId,
      personId: input.personId,
      oldValue: { status: "accepted" },
      newValue: { status: "revoked", reason: input.reason },
    });
    return { declarationId };
  },
);

"use server";
/** Duplicate review actions (crm spec 4.1), implemented by crm-P4. crm-P1 stub. */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { action } from "@/lib/action";

export const dismissDuplicate = action(
  { name: "crm.dismiss_duplicate", audience: "staff", permission: "persons.merge", input: z.object({ candidateId: z.uuid() }) },
  (): Promise<Record<string, never>> => Promise.reject(new NotImplementedError("crm.dismiss_duplicate")),
);

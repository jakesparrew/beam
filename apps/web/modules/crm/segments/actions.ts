"use server";
/** Segment actions (crm spec 4.1), implemented by crm-P5. crm-P1 stubs with the final names and inputs. */
import { z } from "zod";
import { NotImplementedError } from "@beam/core/errors";
import { SegmentRuleSchema } from "@beam/core/crm";
import { action } from "@/lib/action";

const todo =
  <O>(name: string) =>
  (): Promise<O> =>
    Promise.reject(new NotImplementedError(name));

export const saveSegment = action(
  {
    name: "crm.save_segment",
    audience: "staff",
    permission: "email.write",
    input: z.object({
      id: z.uuid().optional(),
      name: z.string().trim().min(1).max(200),
      description: z.string().max(1000).optional(),
      kind: z.enum(["dynamic", "static"]),
      definition: SegmentRuleSchema,
      excludeSegmentIds: z.array(z.uuid()).max(20),
    }),
  },
  todo<{ id: string; count: number | null }>("crm.save_segment"),
);

export const archiveSegment = action(
  { name: "crm.archive_segment", audience: "staff", permission: "email.write", input: z.object({ id: z.uuid() }) },
  todo<Record<string, never>>("crm.archive_segment"),
);

export const setStaticMembers = action(
  {
    name: "crm.set_static_members",
    audience: "staff",
    permission: "email.write",
    input: z.object({ segmentId: z.uuid(), add: z.array(z.uuid()).max(5000), remove: z.array(z.uuid()).max(5000) }),
  },
  todo<{ added: number; removed: number }>("crm.set_static_members"),
);

export const refreshSegmentNow = action(
  { name: "crm.refresh_segment", audience: "staff", permission: "email.write", input: z.object({ segmentId: z.uuid() }) },
  todo<{ jobId: string }>("crm.refresh_segment"),
);

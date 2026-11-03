import { defineJob } from "./define";
import { runMerge } from "./duplicates/jobs";

const syncPerson = defineJob({ kind: "crm.sync_person", lane: "fast", run: async () => undefined });

export const jobs = [
  defineJob({ kind: "crm.merge_persons", lane: "bulk", run: runMerge }),
  syncPerson,
  { kind: "crm.add_suppression", lane: "fast", run: async () => undefined },
] as const;

export const webhookHandlers = [{ provider: "meta", handle: async () => undefined }];

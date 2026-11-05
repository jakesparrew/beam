/**
 * crm jobs (crm spec 4.5). Facade read by `pnpm gen:indexes`: every V1 crm job kind is declared
 * here by crm-P1 with literal keys; the handlers live in the area files and are implemented by
 * crm-P4 (duplicates) and crm-P5 (segments). R3: crm-P8 adds the pipeline kinds (handlers in
 * `./pipeline/jobs`), crm-P9 the inbox kinds.
 */
import { defineJob } from "@/lib/job-runner";
import { CheckDuplicatesInput, DetectDuplicatesInput, runCheckDuplicates, runDetectDuplicates } from "./duplicates/jobs";
import { ApplyBtocPlaybookInput, EscalateOpportunitiesInput, runApplyBtocPlaybook, runEscalateOpportunities } from "./pipeline/jobs";
import { RefreshSegmentInput, RefreshSegmentsInput, runRefreshSegment, runRefreshSegments } from "./segments/jobs";

export const jobs = [
  defineJob({ kind: "crm.check_duplicates", lane: "fast", priority: 5, maxAttempts: 3, input: CheckDuplicatesInput, run: runCheckDuplicates }),
  defineJob({ kind: "crm.detect_duplicates", lane: "bulk", priority: 9, input: DetectDuplicatesInput, run: runDetectDuplicates }),
  defineJob({ kind: "segments.refresh", lane: "fast", priority: 5, input: RefreshSegmentsInput, run: runRefreshSegments }),
  defineJob({ kind: "segments.refresh_one", lane: "bulk", priority: 5, timeoutMs: 60_000, input: RefreshSegmentInput, run: runRefreshSegment }),
  defineJob({ kind: "crm.escalate_opportunities", lane: "fast", priority: 5, input: EscalateOpportunitiesInput, run: runEscalateOpportunities }),
  defineJob({ kind: "crm.apply_btoc_playbook", lane: "fast", priority: 5, input: ApplyBtocPlaybookInput, run: runApplyBtocPlaybook }),
];

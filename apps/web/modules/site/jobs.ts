/**
 * site jobs (site spec section 4, 02-data-model 5.2). Facade read by `pnpm gen:indexes`, written
 * once by site-P1 with every site job kind of all releases: each registration points at the
 * handler in the `jobs/<area>.ts` file of the package that implements it (publish: site-P3,
 * propose: site-P4, wordpress: site-P7, audit: site-P10). A double run of every job yields the same
 * database state (`jobs.test.ts` of each owner).
 */
import { defineJob } from "@/lib/job-runner";
import { auditContent, AuditContentInput } from "./jobs/audit";
import { onProposePageDead, proposePage, ProposePageInput } from "./jobs/propose";
import { publishScheduledVersion, PublishVersionInput } from "./jobs/publish";
import {
  applyWordpress,
  ApplyWordpressInput,
  fetchWordpressMedia,
  FetchWordpressMediaInput,
  onApplyWordpressDead,
  onParseWordpressDead,
  parseWordpress,
  ParseWordpressInput,
} from "./jobs/wordpress";

export const jobs = [
  defineJob({
    kind: "site.propose_page",
    lane: "fast",
    priority: 5,
    input: ProposePageInput,
    maxAttempts: 3,
    timeoutMs: 120_000,
    run: proposePage,
    onDead: onProposePageDead,
  }),
  defineJob({
    kind: "site.publish_version",
    lane: "fast",
    priority: 3,
    input: PublishVersionInput,
    maxAttempts: 6,
    timeoutMs: 30_000,
    run: publishScheduledVersion,
  }),
  defineJob({
    kind: "site.parse_wordpress",
    lane: "bulk",
    priority: 9,
    input: ParseWordpressInput,
    maxAttempts: 3,
    timeoutMs: 120_000,
    run: parseWordpress,
    onDead: onParseWordpressDead,
  }),
  defineJob({
    kind: "site.fetch_wordpress_media",
    lane: "bulk",
    priority: 9,
    input: FetchWordpressMediaInput,
    maxAttempts: 6,
    timeoutMs: 120_000,
    run: fetchWordpressMedia,
  }),
  defineJob({
    kind: "site.apply_wordpress",
    lane: "bulk",
    priority: 9,
    input: ApplyWordpressInput,
    maxAttempts: 6,
    timeoutMs: 120_000,
    run: applyWordpress,
    onDead: onApplyWordpressDead,
  }),
  defineJob({
    kind: "site.audit_content",
    lane: "bulk",
    priority: 9,
    input: AuditContentInput,
    maxAttempts: 3,
    timeoutMs: 300_000,
    run: auditContent,
  }),
];

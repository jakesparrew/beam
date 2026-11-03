/**
 * Platform views (platform spec section 2, data model 2.1). Each view is
 * `pgView(name, columns).existing()` with its SQL exported beside it as `<name>Sql`;
 * `pnpm db:views` writes the migration and `createTestDb()` applies the same SQL (DM-1).
 */
import {
  bigint,
  boolean,
  integer,
  numeric,
  pgView,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  integrationCallsProvider,
  jobsLane,
  jobsStatus,
  supportRequestsSeverity,
  supportRequestsStatus,
} from "./platform";

/** One row per lane and status, for /admin/system and the health endpoint. */
export const vJobStatsSql = `select lane, status, count(*)::int as jobs,
       min(run_at) filter (where status = 'pending') as oldest_pending_run_at,
       max(finished_at) as last_finished_at
from jobs group by lane, status`;

export const vJobStats = pgView("v_job_stats", {
  lane: jobsLane("lane").notNull(),
  status: jobsStatus("status").notNull(),
  jobs: integer("jobs").notNull(),
  oldestPendingRunAt: timestamp("oldest_pending_run_at", {
    withTimezone: true,
  }),
  lastFinishedAt: timestamp("last_finished_at", { withTimezone: true }),
}).existing();

/** Last 24 hours per provider. */
export const vIntegrationHealthSql = `select provider, count(*)::int as calls_24h,
       count(*) filter (where not ok)::int as errors_24h,
       max(created_at) filter (where ok) as last_ok_at,
       max(created_at) filter (where not ok) as last_error_at
from integration_calls where created_at > now() - interval '24 hours' group by provider`;

export const vIntegrationHealth = pgView("v_integration_health", {
  provider: integrationCallsProvider("provider").notNull(),
  calls24h: integer("calls_24h").notNull(),
  errors24h: integer("errors_24h").notNull(),
  lastOkAt: timestamp("last_ok_at", { withTimezone: true }),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
}).existing();

/** Spend and calls per Brussels month and feature. */
export const vAiUsageMonthSql = `select date_trunc('month', created_at at time zone 'Europe/Brussels') as month, feature, model,
       count(*)::int as calls, sum(cost_cents) as cost_cents,
       sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens
from ai_requests group by 1, 2, 3`;

export const vAiUsageMonth = pgView("v_ai_usage_month", {
  month: timestamp("month", { withTimezone: false }).notNull(),
  feature: text("feature").notNull(),
  model: text("model").notNull(),
  calls: integer("calls").notNull(),
  costCents: numeric("cost_cents").notNull(),
  inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
  outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
}).existing();

/** One row per support request with its breach flag (support screen and monthly report). */
export const vSupportSlaSql = `select id, reference, severity, status, received_at, response_due_at, first_response_at, resolved_at,
       coalesce(first_response_at, now()) > response_due_at as is_breached,
       extract(epoch from (first_response_at - received_at))::int / 60 as first_response_minutes
from support_requests`;

export const vSupportSla = pgView("v_support_sla", {
  id: uuid("id").notNull(),
  reference: text("reference").notNull(),
  severity: supportRequestsSeverity("severity").notNull(),
  status: supportRequestsStatus("status").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
  responseDueAt: timestamp("response_due_at", { withTimezone: true }).notNull(),
  firstResponseAt: timestamp("first_response_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  isBreached: boolean("is_breached").notNull(),
  firstResponseMinutes: integer("first_response_minutes"),
}).existing();

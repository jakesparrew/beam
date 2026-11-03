/**
 * Platform tables (platform spec section 2, data model 1.2.1). Frozen after Wave 0.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  bytea,
  createdAt,
  id,
  localeEnum,
  localized,
  timestamps,
  tstz,
  type ActorJson,
} from "./_shared";
import { persons } from "./crm";

// _shared.ts is not in the schema index: re-export the shared enum (so drizzle-kit creates it)
// and the markings, so `@beam/db/schema` consumers reach them too.
export { localeEnum };
export {
  APPEND_ONLY_TABLES,
  IMMUTABLE_TABLES,
  SENSITIVE_COLUMNS,
  type ActorJson,
  type LocalizedText,
} from "./_shared";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const usersAudience = pgEnum("users_audience", ["staff", "customer"]);
export const usersStatus = pgEnum("users_status", ["active", "disabled"]);
export const ROLE_KEYS = [
  "owner",
  "management",
  "customer_service",
  "sales",
  "marketing",
  "finance",
  "reception",
  "technical_admin",
  "external_partner",
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];
export const rolesKey = pgEnum("roles_key", ROLE_KEYS);
export const jobsLane = pgEnum("jobs_lane", ["fast", "bulk"]);
export const jobsStatus = pgEnum("jobs_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "dead",
]);
export const webhookEventsProvider = pgEnum("webhook_events_provider", [
  "mollie",
  "resend",
  "billit",
]);
export const integrationCallsProvider = pgEnum("integration_calls_provider", [
  "mollie",
  "stripe",
  "viva",
  "billit",
  "resend",
  "youtube",
  "meta_ads",
  "google_ads",
  "anthropic",
  "slack",
  "betterstack",
  "wordpress",
]);
export const featureFlagsState = pgEnum("feature_flags_state", [
  "off",
  "testers",
  "on",
]);
export const filesKind = pgEnum("files_kind", [
  "invoice_pdf",
  "import",
  "export",
  "image",
  "rendered_email",
  "receipt",
]);
export const aiRequestsStatus = pgEnum("ai_requests_status", [
  "ok",
  "error",
  "budget_exceeded",
]);
export const securityIncidentsSeverity = pgEnum("security_incidents_severity", [
  "critical",
  "high",
  "normal",
]);
export const securityIncidentsStatus = pgEnum("security_incidents_status", [
  "open",
  "contained",
  "resolved",
]);
export const supportRequestsSeverity = pgEnum("support_requests_severity", [
  "critical",
  "high",
  "normal",
  "improvement",
]);
export const supportRequestsChannel = pgEnum("support_requests_channel", [
  "email",
  "slack",
  "whatsapp",
  "phone",
  "in_app",
]);
export const supportRequestsStatus = pgEnum("support_requests_status", [
  "open",
  "responded",
  "resolved",
  "closed",
]);
export const monthlyReportsStatus = pgEnum("monthly_reports_status", [
  "draft",
  "sent",
]);

// ---------------------------------------------------------------------------
// Users and Auth.js adapter tables
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: id(),
    audience: usersAudience().notNull(),
    email: text().notNull(),
    emailVerified: tstz("email_verified_at"),
    name: text(),
    image: text(),
    passwordHash: text(),
    passwordChangedAt: tstz(),
    locale: localeEnum().notNull().default("nl-BE"),
    roleKey: rolesKey().references((): AnyPgColumn => roles.key, {
      onUpdate: "cascade",
      onDelete: "restrict",
    }),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    totpSecretEnc: bytea(),
    recoveryCodesEnc: bytea(),
    secretKeyVersion: smallint(),
    mfaEnrolledAt: tstz(),
    isTester: boolean().notNull().default(false),
    failedLogins: integer().notNull().default(0),
    lockedUntil: tstz(),
    lastLoginAt: tstz(),
    status: usersStatus().notNull().default("active"),
    createdByUserId: uuid().references((): AnyPgColumn => users.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`),
    uniqueIndex("users_customer_person_uq")
      .on(t.personId)
      .where(sql`${t.audience} = 'customer'`),
    index("users_role_idx")
      .on(t.roleKey)
      .where(sql`${t.audience} = 'staff'`),
    check(
      "users_email_ck",
      sql`${t.email} = lower(${t.email}) and position('@' in ${t.email}) > 1`,
    ),
    check(
      "users_password_hash_ck",
      sql`${t.passwordHash} is null or ${t.passwordHash} like '$argon2id$%'`,
    ),
    check("users_failed_logins_ck", sql`${t.failedLogins} >= 0`),
    check(
      "users_audience_shape_ck",
      sql`(${t.audience} = 'staff' and ${t.roleKey} is not null) or (${t.audience} = 'customer' and ${t.roleKey} is null and ${t.personId} is not null)`,
    ),
    check(
      "users_partner_person_ck",
      sql`${t.roleKey} <> 'external_partner' or ${t.personId} is not null`,
    ),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text().notNull(),
    provider: text().notNull(),
    providerAccountId: text().notNull(),
    refreshToken: text(),
    accessToken: text(),
    expiresAt: integer(),
    tokenType: text(),
    scope: text(),
    idToken: text(),
    sessionState: text(),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(),
    sessionToken: text().notNull().unique("auth_sessions_session_token_unique"),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    audience: usersAudience().notNull(),
    expires: tstz("expires_at").notNull(),
    absoluteExpiresAt: tstz().notNull(),
    mfaAt: tstz(),
    lastSeenAt: tstz().notNull().defaultNow(),
    ip: text(),
    userAgent: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("auth_sessions_user_idx").on(t.userId),
    index("auth_sessions_expires_idx").on(t.expires),
    check(
      "auth_sessions_absolute_ck",
      sql`${t.absoluteExpiresAt} >= ${t.createdAt}`,
    ),
  ],
);

export const authVerificationTokens = pgTable(
  "auth_verification_tokens",
  {
    identifier: text().notNull(),
    token: text().notNull(),
    expires: tstz("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.identifier, t.token] }),
    index("auth_verification_tokens_expires_idx").on(t.expires),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: id(),
    key: rolesKey().notNull().unique(),
    name: localized().notNull(),
    description: localized().notNull().default({}),
    permissions: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    seededPermissions: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    isSystem: boolean().notNull().default(true),
    updatedByUserId: uuid().references((): AnyPgColumn => users.id),
    ...timestamps(),
  },
  (t) => [
    check(
      "roles_owner_all_ck",
      sql`${t.key} <> 'owner' or ${t.permissions} = '{*}'::text[]`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Jobs, webhooks, integration log, audit
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    kind: text().notNull(),
    payload: jsonb().notNull().default({}),
    idempotencyKey: text().notNull().unique("jobs_idempotency_key_unique"),
    lane: jobsLane().notNull().default("fast"),
    priority: smallint().notNull().default(5),
    status: jobsStatus().notNull().default("pending"),
    runAt: tstz().notNull().defaultNow(),
    attempts: integer().notNull().default(0),
    maxAttempts: integer().notNull().default(6),
    lockedAt: tstz(),
    lockedBy: text(),
    lastError: text(),
    result: jsonb(),
    requestId: text(),
    startedAt: tstz(),
    finishedAt: tstz(),
    ...timestamps(),
  },
  (t) => [
    index("jobs_pending_idx")
      .on(t.lane, t.priority, t.runAt)
      .where(sql`${t.status} = 'pending'`),
    index("jobs_running_idx")
      .on(t.lockedAt)
      .where(sql`${t.status} = 'running'`),
    index("jobs_done_idx")
      .on(t.status, t.finishedAt)
      .where(sql`${t.status} in ('succeeded', 'dead')`),
    index("jobs_kind_idx").on(t.kind, t.status, t.createdAt.desc()),
    check("jobs_kind_ck", sql`${t.kind} ~ '^[a-z_]+\\.[a-z_]+$'`),
    check("jobs_priority_ck", sql`${t.priority} between 1 and 9`),
    check("jobs_attempts_ck", sql`${t.attempts} >= 0`),
    check("jobs_max_attempts_ck", sql`${t.maxAttempts} >= 1`),
    check(
      "jobs_running_lock_ck",
      sql`${t.status} <> 'running' or ${t.lockedAt} is not null`,
    ),
  ],
);

/** APPEND. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    provider: webhookEventsProvider().notNull(),
    externalEventId: text().notNull(),
    payload: jsonb().notNull(),
    receivedAt: tstz().notNull().defaultNow(),
    jobId: uuid().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("webhook_events_provider_external_uq").on(
      t.provider,
      t.externalEventId,
    ),
    index("webhook_events_provider_received_idx").on(
      t.provider,
      t.receivedAt.desc(),
    ),
  ],
);

/** APPEND. */
export const integrationCalls = pgTable(
  "integration_calls",
  {
    id: id(),
    provider: integrationCallsProvider().notNull(),
    operation: text().notNull(),
    requestDigest: text().notNull(),
    statusCode: integer(),
    ok: boolean().notNull(),
    durationMs: integer().notNull(),
    error: text(),
    jobId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [
    index("integration_calls_provider_created_idx").on(
      t.provider,
      t.createdAt.desc(),
    ),
    index("integration_calls_created_idx").on(t.createdAt),
    index("integration_calls_job_idx").on(t.jobId),
    check("integration_calls_duration_ck", sql`${t.durationMs} >= 0`),
  ],
);

/** APPEND. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    actor: jsonb().$type<ActorJson>().notNull(),
    action: text().notNull(),
    entityType: text().notNull(),
    entityId: text(),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    oldValue: jsonb(),
    newValue: jsonb(),
    requestId: text(),
    ip: text(),
    isRedacted: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_entity_idx").on(
      t.entityType,
      t.entityId,
      t.createdAt.desc(),
    ),
    index("audit_log_person_idx").on(t.personId, t.createdAt.desc()),
    index("audit_log_action_idx").on(t.action, t.createdAt.desc()),
    index("audit_log_created_idx").on(t.createdAt.desc()),
    index("audit_log_actor_idx").on(
      sql`(${t.actor}->>'id')`,
      t.createdAt.desc(),
    ),
    check(
      "audit_log_action_ck",
      sql`${t.action} ~ '^[a-z_]+(\\.[a-z_]+){1,2}$'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Settings, flags, files, AI
// ---------------------------------------------------------------------------

export const settings = pgTable(
  "settings",
  {
    id: id(),
    key: text().notNull().unique(),
    value: jsonb().notNull(),
    version: integer().notNull().default(1),
    updatedByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    check("settings_key_ck", sql`${t.key} ~ '^[a-z_]+$'`),
    check("settings_version_ck", sql`${t.version} >= 1`),
  ],
);

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: id(),
    key: text().notNull().unique(),
    state: featureFlagsState().notNull().default("off"),
    userIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    personIds: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    description: text().notNull().default(""),
    updatedByUserId: uuid().references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    check("feature_flags_key_ck", sql`${t.key} ~ '^ff_[a-z]+_[a-z0-9_]+$'`),
  ],
);

export const files = pgTable(
  "files",
  {
    id: id(),
    kind: filesKind().notNull(),
    name: text().notNull(),
    mime: text().notNull(),
    sizeBytes: integer().notNull(),
    bytes: bytea().notNull(),
    sha256: text().notNull(),
    isPublic: boolean().notNull().default(false),
    expiresAt: tstz(),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    createdByUserId: uuid().references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    index("files_person_idx").on(t.personId),
    index("files_expires_idx")
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
    index("files_kind_created_idx").on(t.kind, t.createdAt.desc()),
    index("files_sha256_idx").on(t.sha256),
    check(
      "files_name_ck",
      sql`char_length(${t.name}) between 1 and 200 and strpos(${t.name}, '/') = 0 and strpos(${t.name}, chr(92)) = 0`,
    ),
    check("files_size_ck", sql`${t.sizeBytes} between 0 and 10485760`),
    check("files_sha256_ck", sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      "files_public_kind_ck",
      sql`not ${t.isPublic} or ${t.kind} = 'image'`,
    ),
    check(
      "files_mime_ck",
      sql`${t.kind} <> 'image' or ${t.mime} in ('image/png', 'image/jpeg', 'image/webp', 'image/gif')`,
    ),
  ],
);

/** APPEND. */
export const aiRequests = pgTable(
  "ai_requests",
  {
    id: id(),
    feature: text().notNull(),
    model: text().notNull(),
    actor: jsonb().$type<ActorJson>().notNull(),
    personId: uuid().references(() => persons.id, { onDelete: "restrict" }),
    fieldsSent: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    prompt: text().notNull(),
    output: text(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    costCents: numeric({ precision: 12, scale: 4 }).notNull().default("0"),
    status: aiRequestsStatus().notNull(),
    error: text(),
    jobId: uuid(),
    durationMs: integer(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_requests_created_idx").on(t.createdAt),
    index("ai_requests_feature_idx").on(t.feature, t.createdAt.desc()),
    index("ai_requests_person_idx").on(t.personId),
    check(
      "ai_requests_model_ck",
      sql`${t.model} in ('claude-opus-5-5', 'claude-haiku-5-5')`,
    ),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text().primaryKey(),
    windowStart: tstz().notNull(),
    count: integer().notNull().default(0),
    expiresAt: tstz().notNull(),
  },
  (t) => [index("rate_limits_expires_idx").on(t.expiresAt)],
);

// ---------------------------------------------------------------------------
// Security incidents, support requests, monthly reports
// ---------------------------------------------------------------------------

export const securityIncidents = pgTable(
  "security_incidents",
  {
    id: id(),
    title: text().notNull(),
    severity: securityIncidentsSeverity().notNull(),
    status: securityIncidentsStatus().notNull().default("open"),
    discoveredAt: tstz().notNull(),
    beamNotifiedAt: tstz(),
    systemsAffected: text().notNull().default(""),
    dataAffected: text().notNull().default(""),
    risk: text().notNull().default(""),
    actions: text().notNull().default(""),
    notifications: text().notNull().default(""),
    resolution: text().notNull().default(""),
    resolvedAt: tstz(),
    createdByUserId: uuid()
      .notNull()
      .references(() => users.id),
    ...timestamps(),
  },
  (t) => [
    index("security_incidents_status_idx").on(t.status, t.discoveredAt.desc()),
    check(
      "security_incidents_resolved_ck",
      sql`${t.status} <> 'resolved' or ${t.resolvedAt} is not null`,
    ),
  ],
);

export const supportRequests = pgTable(
  "support_requests",
  {
    id: id(),
    reference: text().notNull().unique(),
    severity: supportRequestsSeverity().notNull(),
    channel: supportRequestsChannel().notNull(),
    title: text().notNull(),
    description: text().notNull().default(""),
    status: supportRequestsStatus().notNull().default("open"),
    receivedAt: tstz().notNull(),
    responseDueAt: tstz().notNull(),
    firstResponseAt: tstz(),
    resolvedAt: tstz(),
    reportedByUserId: uuid().references(() => users.id),
    assigneeUserId: uuid().references(() => users.id),
    incidentId: uuid().references(() => securityIncidents.id),
    pageUrl: text(),
    requestId: text(),
    ...timestamps(),
  },
  (t) => [
    index("support_requests_status_due_idx").on(t.status, t.responseDueAt),
    index("support_requests_received_idx").on(t.receivedAt.desc()),
    check(
      "support_requests_title_ck",
      sql`char_length(${t.title}) between 3 and 200`,
    ),
    check(
      "support_requests_first_response_ck",
      sql`${t.firstResponseAt} is null or ${t.firstResponseAt} >= ${t.receivedAt}`,
    ),
    check(
      "support_requests_resolved_ck",
      sql`${t.status} not in ('resolved', 'closed') or ${t.resolvedAt} is not null`,
    ),
  ],
);

/** Counts only, no personal data (`MonthlyReportData`, platform spec section 2). */
export type MonthlyReportData = {
  uptime_pct: number;
  downtime_minutes: number;
  uptime_source: "betterstack" | "manual";
  incidents: { critical: number; high: number; normal: number };
  support: {
    per_severity: Record<
      "critical" | "high" | "normal" | "improvement",
      {
        received: number;
        resolved: number;
        median_first_response_minutes: number | null;
        breaches: number;
      }
    >;
  };
  dead_jobs: number;
  alerts_sent: number;
  backups_ok: number;
  backups_failed: number;
  restore_drill: { at: string; ok: boolean } | null;
  ai_spend_cents: number;
  db_size_bytes: number;
  files_size_bytes: number;
};

export const monthlyReports = pgTable("monthly_reports", {
  id: id(),
  monthOn: date().notNull().unique("monthly_reports_month_on_unique"),
  status: monthlyReportsStatus().notNull().default("draft"),
  data: jsonb().$type<MonthlyReportData>().notNull(),
  notes: text().notNull().default(""),
  sentAt: tstz(),
  sentByUserId: uuid().references(() => users.id),
  ...timestamps(),
});

/**
 * Platform read functions for its own screens (platform spec 4.3), the platform-P6 part:
 * the current user, own sessions, jobs (keyset-paginated, 50 rows, cursor `created_at,id`)
 * and the job detail with its provider calls. Explicit columns only.
 */
import type { DbOrTx } from "@beam/db";
import type { AnyColumn } from "drizzle-orm";
import { AI_FEATURE_KEYS, AI_FEATURES } from "@beam/core/ai";
import { MESSAGES, type Locale } from "@beam/core/i18n";
import { GO_LIVE_ITEMS, isGateItemConfirmed, type GoLiveGate } from "@beam/core/platform";
import {
  auditLog,
  authSessions,
  featureFlags,
  integrationCalls,
  jobs,
  monthlyReports,
  roles,
  ROLE_KEYS,
  securityIncidents,
  settings,
  supportRequests,
  users,
  webhookEvents,
  type RoleKey,
} from "@beam/db/schema";
import { redactForAudit } from "@/lib/audit";
import { and, desc, eq, gte, lt, lte, or, sql, type SQL } from "@/lib/ctx";
import { loadSettingsRegistry, getSetting } from "@/lib/settings";
import { rowsOf } from "@/lib/sensitive";
import { FLAGS } from "@/registry/flags.generated";
import { PERMISSION_MODULE, PERMISSIONS } from "@/registry/permissions.generated";
import { SETTINGS } from "@/registry/settings.generated";

export const PAGE_SIZE = 50;

export type JobStatus = (typeof jobs.$inferSelect)["status"];
export type JobLane = (typeof jobs.$inferSelect)["lane"];

export async function getCurrentUser(tx: DbOrTx, userId: string) {
  const [row] = await tx
    .select({ id: users.id, email: users.email, name: users.name, locale: users.locale, roleKey: users.roleKey, isTester: users.isTester, mfaEnrolledAt: users.mfaEnrolledAt, hasPassword: sql<boolean>`${users.passwordHash} is not null` })
    .from(users)
    .where(eq(users.id, userId));
  return row ?? null;
}

export async function listSessions(tx: DbOrTx, userId: string) {
  return tx
    .select({ id: authSessions.id, sessionToken: authSessions.sessionToken, createdAt: authSessions.createdAt, lastSeenAt: authSessions.lastSeenAt, ip: authSessions.ip, userAgent: authSessions.userAgent, mfaAt: authSessions.mfaAt })
    .from(authSessions)
    .where(eq(authSessions.userId, userId))
    .orderBy(desc(authSessions.lastSeenAt));
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()},${row.id}`;
}

export function decodeCursor(cursor: string | null | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split(",");
  const createdAt = new Date(at ?? "");
  if (!id || Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { createdAt, id };
}

export type ListJobsInput = { status?: JobStatus | "all"; kind?: string; lane?: JobLane; q?: string; cursor?: string | null };

export type JobListRow = {
  id: string;
  kind: string;
  status: JobStatus;
  lane: JobLane;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lastError: string | null;
  key: string;
  createdAt: Date;
};

/** Jobs newest first; the screen's default filter is `dead`. */
export async function listJobs(tx: DbOrTx, input: ListJobsInput = {}): Promise<{ rows: JobListRow[]; nextCursor: string | null }> {
  const where: SQL[] = [];
  const status = input.status ?? "dead";
  if (status !== "all") where.push(eq(jobs.status, status));
  if (input.kind) where.push(eq(jobs.kind, input.kind));
  if (input.lane) where.push(eq(jobs.lane, input.lane));
  if (input.q) where.push(sql`${jobs.idempotencyKey} ilike ${`%${input.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`}`);
  const cursor = decodeCursor(input.cursor);
  if (cursor) where.push(or(lt(jobs.createdAt, cursor.createdAt), and(eq(jobs.createdAt, cursor.createdAt), lt(jobs.id, cursor.id)))!);
  const rows = await tx
    .select({
      id: jobs.id,
      kind: jobs.kind,
      status: jobs.status,
      lane: jobs.lane,
      attempts: jobs.attempts,
      maxAttempts: jobs.maxAttempts,
      runAt: jobs.runAt,
      lastError: jobs.lastError,
      key: jobs.idempotencyKey,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(PAGE_SIZE + 1);
  const page = rows.slice(0, PAGE_SIZE);
  return { rows: page, nextCursor: rows.length > PAGE_SIZE ? encodeCursor(page[page.length - 1]!) : null };
}

/** The distinct job kinds, for the filter. */
export async function listJobKinds(tx: DbOrTx): Promise<string[]> {
  return rowsOf<{ kind: string }>(await tx.execute(sql`select distinct kind from jobs order by kind limit 500`)).map((r) => r.kind);
}

/** One job with its payload (secret keys redacted) and the provider calls it made. */
export async function getJob(tx: DbOrTx, jobId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return null;
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) return null;
  const calls = await tx
    .select({ id: integrationCalls.id, provider: integrationCalls.provider, operation: integrationCalls.operation, ok: integrationCalls.ok, statusCode: integrationCalls.statusCode, durationMs: integrationCalls.durationMs, error: integrationCalls.error, createdAt: integrationCalls.createdAt })
    .from(integrationCalls)
    .where(eq(integrationCalls.jobId, jobId))
    .orderBy(integrationCalls.createdAt)
    .limit(200);
  return { ...job, payload: redactForAudit(job.payload), result: redactForAudit(job.result), calls };
}

/** Rows of `v_job_stats`. */
export async function getJobStats(tx: DbOrTx) {
  return rowsOf<{ lane: JobLane; status: JobStatus; jobs: number; oldest_pending_run_at: string | null; last_finished_at: string | null }>(
    await tx.execute(sql`select lane, status, jobs, oldest_pending_run_at, last_finished_at from v_job_stats order by lane, status`),
  );
}

// ---------------------------------------------------------------------------
// platform-P8: shared keyset helper
// ---------------------------------------------------------------------------

type Keyset = { createdAt: Date; id: string };

/** `(created_at, id) < cursor` for a newest-first list (one row comparison, index friendly). */
function before(createdAt: AnyColumn, idCol: AnyColumn, cursor: Keyset | null): SQL | undefined {
  if (!cursor) return undefined;
  return sql`(${createdAt}, ${idCol}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`;
}

function page<T extends Keyset>(rows: T[]): { rows: T[]; nextCursor: string | null } {
  const head = rows.slice(0, PAGE_SIZE);
  return { rows: head, nextCursor: rows.length > PAGE_SIZE ? encodeCursor(head[head.length - 1]!) : null };
}

const likeArg = (q: string) => `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
const isUuid = (v: string | null | undefined): v is string => !!v && /^[0-9a-f-]{36}$/i.test(v);

// ---------------------------------------------------------------------------
// Staff users and roles
// ---------------------------------------------------------------------------

export type StaffUserRow = {
  id: string;
  email: string;
  name: string | null;
  roleKey: RoleKey;
  status: "active" | "disabled";
  mfaEnrolledAt: Date | null;
  lastLoginAt: Date | null;
  lockedUntil: Date | null;
  invitePending: boolean;
  createdAt: Date;
};

export async function listStaffUsers(
  tx: DbOrTx,
  input: { q?: string; roleKey?: RoleKey; status?: "active" | "disabled"; cursor?: string | null } = {},
): Promise<{ rows: StaffUserRow[]; nextCursor: string | null }> {
  const where: SQL[] = [eq(users.audience, "staff")];
  if (input.q) where.push(or(sql`${users.email} ilike ${likeArg(input.q)}`, sql`${users.name} ilike ${likeArg(input.q)}`)!);
  if (input.roleKey) where.push(eq(users.roleKey, input.roleKey));
  if (input.status) where.push(eq(users.status, input.status));
  const c = before(users.createdAt, users.id, decodeCursor(input.cursor));
  if (c) where.push(c);
  const rows = await tx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      roleKey: sql<RoleKey>`${users.roleKey}`,
      status: users.status,
      mfaEnrolledAt: users.mfaEnrolledAt,
      lastLoginAt: users.lastLoginAt,
      lockedUntil: users.lockedUntil,
      invitePending: sql<boolean>`${users.passwordHash} is null`,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(...where))
    .orderBy(desc(users.createdAt), desc(users.id))
    .limit(PAGE_SIZE + 1);
  return page(rows);
}

export async function getStaffUser(tx: DbOrTx, userId: string) {
  if (!isUuid(userId)) return null;
  const [user] = await tx
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      locale: users.locale,
      roleKey: sql<RoleKey>`${users.roleKey}`,
      status: users.status,
      isTester: users.isTester,
      mfaEnrolledAt: users.mfaEnrolledAt,
      lastLoginAt: users.lastLoginAt,
      lockedUntil: users.lockedUntil,
      failedLogins: users.failedLogins,
      invitePending: sql<boolean>`${users.passwordHash} is null`,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.audience, "staff")));
  if (!user) return null;
  const sessions = (await listSessions(tx, userId)).map(({ sessionToken: _t, ...s }) => s);
  const audit = await tx
    .select({ id: auditLog.id, action: auditLog.action, actor: auditLog.actor, oldValue: auditLog.oldValue, newValue: auditLog.newValue, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "users"), eq(auditLog.entityId, userId)))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(20);
  return { ...user, sessions, audit };
}

export type RoleRow = { key: RoleKey; name: Record<string, string>; permissions: string[]; members: number; unknownPermissions: string[] };

export async function listRoles(tx: DbOrTx): Promise<RoleRow[]> {
  const known = new Set<string>(PERMISSIONS);
  const rows = rowsOf<{ key: RoleKey; name: Record<string, string>; permissions: string[]; members: number }>(
    await tx.execute(sql`
      select r.key::text as key, r.name, r.permissions,
             (select count(*)::int from users u where u.role_key = r.key and u.audience = 'staff' and u.status = 'active') as members
      from roles r order by array_position(enum_range(null::roles_key), r.key)`),
  );
  return rows.map((r) => ({ ...r, members: Number(r.members), unknownPermissions: r.permissions.filter((p) => p !== "*" && !known.has(p)) }));
}

/** One role with the registry's permissions grouped by module (PL-18: unknown strings listed apart). */
export async function getRole(tx: DbOrTx, roleKey: string) {
  if (!(ROLE_KEYS as readonly string[]).includes(roleKey)) return null;
  const [role] = await tx
    .select({ key: roles.key, name: roles.name, description: roles.description, permissions: roles.permissions, updatedAt: roles.updatedAt })
    .from(roles)
    .where(eq(roles.key, roleKey as RoleKey));
  if (!role) return null;
  const groups = new Map<string, string[]>();
  for (const p of PERMISSIONS) {
    const m = (PERMISSION_MODULE as Record<string, string>)[p] ?? p.split(".")[0]!;
    groups.set(m, [...(groups.get(m) ?? []), p]);
  }
  const known = new Set<string>(PERMISSIONS);
  return {
    ...role,
    isOwner: role.key === "owner",
    groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([module, permissions]) => ({ module, permissions })),
    unknownPermissions: role.permissions.filter((p) => p !== "*" && !known.has(p)),
  };
}

// ---------------------------------------------------------------------------
// Settings and flags
// ---------------------------------------------------------------------------

export type SettingListRow = { key: string; owner: string; description: string; version: number; updatedAt: Date | null; isSystem: boolean };

export async function listSettings(tx: DbOrTx): Promise<SettingListRow[]> {
  const stored = await tx.select({ key: settings.key, version: settings.version, updatedAt: settings.updatedAt }).from(settings);
  const byKey = new Map(stored.map((s) => [s.key, s]));
  return Object.entries(SETTINGS as Record<string, { owner: string; description?: string; isSystem?: boolean }>)
    .map(([key, def]) => ({
      key,
      owner: def.owner,
      description: def.description ?? "",
      version: byKey.get(key)?.version ?? 0,
      updatedAt: byKey.get(key)?.updatedAt ?? null,
      isSystem: !!def.isSystem,
    }))
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.key.localeCompare(b.key));
}

/** Value, version, last editor and the Zod schema of one declared key (null for an unknown key). */
export async function getSettingForEdit(tx: DbOrTx, key: string) {
  const def = (await loadSettingsRegistry())[key];
  if (!def) return null;
  const [row] = await tx
    .select({ value: settings.value, version: settings.version, updatedAt: settings.updatedAt, updatedBy: users.name, updatedByEmail: users.email })
    .from(settings)
    .leftJoin(users, eq(users.id, settings.updatedByUserId))
    .where(eq(settings.key, key));
  return {
    key,
    owner: (SETTINGS as Record<string, { owner: string }>)[key]?.owner ?? "platform",
    description: def.description ?? "",
    isSystem: !!def.isSystem,
    schema: def.schema,
    value: row ? row.value : def.default,
    version: row?.version ?? 0,
    updatedAt: row?.updatedAt ?? null,
    updatedBy: row ? (row.updatedBy ?? row.updatedByEmail ?? null) : null,
  };
}

export type FlagListRow = {
  key: string;
  owner: string;
  description: string;
  state: "off" | "testers" | "on";
  userIds: string[];
  personIds: string[];
  updatedAt: Date | null;
  updatedBy: string | null;
};

/** Declared flags (registry) joined with their rows; a flag without a row is `off` (PL-43). */
export async function listFlags(tx: DbOrTx): Promise<FlagListRow[]> {
  const rows = await tx
    .select({ key: featureFlags.key, state: featureFlags.state, userIds: featureFlags.userIds, personIds: featureFlags.personIds, updatedAt: featureFlags.updatedAt, updatedBy: users.name })
    .from(featureFlags)
    .leftJoin(users, eq(users.id, featureFlags.updatedByUserId));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return Object.entries(FLAGS as Record<string, { owner: string; description?: string }>)
    .map(([key, def]) => {
      const row = byKey.get(key);
      return {
        key,
        owner: def.owner,
        description: def.description ?? "",
        state: row?.state ?? "off",
        userIds: row?.userIds ?? [],
        personIds: row?.personIds ?? [],
        updatedAt: row?.updatedAt ?? null,
        updatedBy: row?.updatedBy ?? null,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Webhooks and integrations
// ---------------------------------------------------------------------------

export type WebhookProviderName = (typeof webhookEvents.$inferSelect)["provider"];
export type IntegrationProviderName = (typeof integrationCalls.$inferSelect)["provider"];

export async function listWebhookEvents(tx: DbOrTx, input: { provider?: WebhookProviderName; from?: Date; to?: Date; cursor?: string | null } = {}) {
  const where: SQL[] = [];
  if (input.provider) where.push(eq(webhookEvents.provider, input.provider));
  if (input.from) where.push(gte(webhookEvents.receivedAt, input.from));
  if (input.to) where.push(lte(webhookEvents.receivedAt, input.to));
  const c = before(webhookEvents.createdAt, webhookEvents.id, decodeCursor(input.cursor));
  if (c) where.push(c);
  const rows = await tx
    .select({
      id: webhookEvents.id,
      provider: webhookEvents.provider,
      externalEventId: webhookEvents.externalEventId,
      receivedAt: webhookEvents.receivedAt,
      jobId: webhookEvents.jobId,
      jobStatus: jobs.status,
      createdAt: webhookEvents.createdAt,
    })
    .from(webhookEvents)
    .leftJoin(jobs, eq(jobs.id, webhookEvents.jobId))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(webhookEvents.createdAt), desc(webhookEvents.id))
    .limit(PAGE_SIZE + 1);
  return page(rows);
}

/** One event with its payload (secret keys redacted), its job and its replays. */
export async function getWebhookEvent(tx: DbOrTx, id: string) {
  if (!isUuid(id)) return null;
  const [event] = await tx.select().from(webhookEvents).where(eq(webhookEvents.id, id));
  if (!event) return null;
  const [job] = await tx
    .select({ id: jobs.id, status: jobs.status, attempts: jobs.attempts, lastError: jobs.lastError, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(eq(jobs.id, event.jobId));
  const replays = await tx
    .select({ id: auditLog.id, newValue: auditLog.newValue, actor: auditLog.actor, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(eq(auditLog.action, "webhooks.replay"), eq(auditLog.entityId, id)))
    .orderBy(desc(auditLog.createdAt));
  return { ...event, payload: redactForAudit(event.payload), job: job ?? null, replays };
}

export async function listIntegrationCalls(tx: DbOrTx, input: { provider?: IntegrationProviderName; ok?: boolean; cursor?: string | null; limit?: number } = {}) {
  const where: SQL[] = [];
  if (input.provider) where.push(eq(integrationCalls.provider, input.provider));
  if (input.ok !== undefined) where.push(eq(integrationCalls.ok, input.ok));
  const c = before(integrationCalls.createdAt, integrationCalls.id, decodeCursor(input.cursor));
  if (c) where.push(c);
  const limit = Math.min(input.limit ?? PAGE_SIZE, 200);
  const rows = await tx
    .select({
      id: integrationCalls.id,
      provider: integrationCalls.provider,
      operation: integrationCalls.operation,
      statusCode: integrationCalls.statusCode,
      ok: integrationCalls.ok,
      durationMs: integrationCalls.durationMs,
      error: integrationCalls.error,
      jobId: integrationCalls.jobId,
      createdAt: integrationCalls.createdAt,
    })
    .from(integrationCalls)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(integrationCalls.createdAt), desc(integrationCalls.id))
    .limit(limit + 1);
  const head = rows.slice(0, limit);
  return { rows: head, nextCursor: rows.length > limit ? encodeCursor(head[head.length - 1]!) : null };
}

export async function getIntegrationHealth(tx: DbOrTx) {
  return rowsOf<{ provider: string; calls_24h: number; errors_24h: number; last_ok_at: string | null; last_error_at: string | null }>(
    await tx.execute(sql`select provider::text as provider, calls_24h, errors_24h, last_ok_at, last_error_at from v_integration_health order by provider`),
  );
}

/**
 * R3 (platform-P9): the token-based integrations of the System integrations screen. The ads pulls
 * (`meta_ads`, `google_ads`, ops' `ads.pull_yesterday`) run once a day, so their health is not
 * read from the 24-hour view: `dataAsOf` is the last successful call ever (for `meta`, crm's
 * inbox, also the last received webhook). Only env names are read, never values.
 */
export const TOKEN_INTEGRATIONS = [
  { provider: "meta_ads", envNames: ["META_ADS_TOKEN"] },
  { provider: "google_ads", envNames: ["GOOGLE_ADS_TOKEN"] },
  { provider: "meta", envNames: ["META_APP_SECRET", "META_PAGE_ACCESS_TOKEN", "META_VERIFY_TOKEN"] },
] as const satisfies readonly { provider: IntegrationProviderName; envNames: readonly string[] }[];

export type TokenIntegrationStatus = {
  provider: (typeof TOKEN_INTEGRATIONS)[number]["provider"];
  /** Each env name and whether it holds a value. */
  tokens: { name: string; configured: boolean }[];
  configured: boolean;
  dataAsOf: Date | null;
  lastErrorAt: Date | null;
};

export async function getTokenIntegrationStatus(
  tx: DbOrTx,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TokenIntegrationStatus[]> {
  const providers = TOKEN_INTEGRATIONS.map((i) => i.provider);
  const calls = rowsOf<{ provider: string; last_ok_at: string | Date | null; last_error_at: string | Date | null }>(
    await tx.execute(sql`
      select provider::text as provider, max(created_at) filter (where ok) as last_ok_at, max(created_at) filter (where not ok) as last_error_at
      from integration_calls where provider::text in (${sql.join(
        providers.map((p) => sql`${p}`),
        sql`, `,
      )}) group by provider`),
  );
  const [hook] = rowsOf<{ last_at: string | Date | null }>(
    await tx.execute(sql`select max(received_at) as last_at from webhook_events where provider::text = 'meta'`),
  );
  const date = (v: string | Date | null | undefined) => (v ? new Date(v) : null);
  const latest = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));
  return TOKEN_INTEGRATIONS.map((i) => {
    const row = calls.find((c) => c.provider === i.provider);
    const tokens = i.envNames.map((name) => ({ name, configured: !!env[name]?.trim() }));
    const lastOk = date(row?.last_ok_at);
    return {
      provider: i.provider,
      tokens,
      configured: tokens.every((t) => t.configured),
      dataAsOf: i.provider === "meta" ? latest(lastOk, date(hook?.last_at)) : lastOk,
      lastErrorAt: date(row?.last_error_at),
    };
  });
}

// ---------------------------------------------------------------------------
// Audit search (keyset on created_at, id)
// ---------------------------------------------------------------------------

export type AuditSearchInput = {
  actorId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  personId?: string;
  from?: Date;
  to?: Date;
  cursor?: string | null;
  limit?: number;
};

export function auditWhere(input: AuditSearchInput): SQL | undefined {
  const where: SQL[] = [];
  if (input.actorId) where.push(sql`(${auditLog.actor}->>'id') = ${input.actorId}`);
  if (input.action) where.push(input.action.endsWith(".") ? sql`${auditLog.action} like ${`${input.action}%`}` : eq(auditLog.action, input.action));
  if (input.entityType) where.push(eq(auditLog.entityType, input.entityType));
  if (input.entityId) where.push(eq(auditLog.entityId, input.entityId));
  if (isUuid(input.personId)) where.push(eq(auditLog.personId, input.personId));
  if (input.from) where.push(gte(auditLog.createdAt, input.from));
  if (input.to) where.push(lt(auditLog.createdAt, input.to));
  const c = before(auditLog.createdAt, auditLog.id, decodeCursor(input.cursor));
  if (c) where.push(c);
  return where.length ? and(...where) : undefined;
}

export async function searchAudit(tx: DbOrTx, input: AuditSearchInput = {}) {
  const limit = Math.min(input.limit ?? PAGE_SIZE, 5000);
  const rows = await tx
    .select({
      id: auditLog.id,
      actor: auditLog.actor,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      personId: auditLog.personId,
      oldValue: auditLog.oldValue,
      newValue: auditLog.newValue,
      requestId: auditLog.requestId,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(auditWhere(input))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit + 1);
  const head = rows.slice(0, limit);
  return { rows: head, nextCursor: rows.length > limit ? encodeCursor(head[head.length - 1]!) : null };
}

// ---------------------------------------------------------------------------
// Incidents, go-live gate, AI usage, security
// ---------------------------------------------------------------------------

export async function listIncidents(tx: DbOrTx, input: { status?: "open" | "contained" | "resolved" } = {}) {
  return tx
    .select({
      id: securityIncidents.id,
      title: securityIncidents.title,
      severity: securityIncidents.severity,
      status: securityIncidents.status,
      discoveredAt: securityIncidents.discoveredAt,
      beamNotifiedAt: securityIncidents.beamNotifiedAt,
      resolvedAt: securityIncidents.resolvedAt,
      createdAt: securityIncidents.createdAt,
    })
    .from(securityIncidents)
    .where(input.status ? eq(securityIncidents.status, input.status) : undefined)
    .orderBy(desc(securityIncidents.discoveredAt), desc(securityIncidents.id))
    .limit(500);
}

export async function getIncident(tx: DbOrTx, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await tx.select().from(securityIncidents).where(eq(securityIncidents.id, id));
  return row ?? null;
}

export type GateRow = { key: (typeof GO_LIVE_ITEMS)[number]; confirmed: boolean; confirmedAt: string | null; confirmedBy: string | null; note: string | null };

export async function getGoLiveGate(tx: DbOrTx): Promise<{ items: GateRow[]; confirmed: number; total: number; complete: boolean }> {
  const gate = (await getSetting(tx, "go_live_gate")) as GoLiveGate;
  const ids = GO_LIVE_ITEMS.map((k) => gate.items[k]?.confirmed_by_user_id).filter(isUuid);
  const names = ids.length ? await tx.select({ id: users.id, name: users.name, email: users.email }).from(users).where(sql`${users.id} in ${ids}`) : [];
  const nameOf = new Map(names.map((n) => [n.id, n.name ?? n.email]));
  const items = GO_LIVE_ITEMS.map((key) => {
    const item = gate.items[key] ?? null;
    return {
      key,
      confirmed: isGateItemConfirmed(item),
      confirmedAt: item?.confirmed_at ?? null,
      confirmedBy: item?.confirmed_by_user_id ? (nameOf.get(item.confirmed_by_user_id) ?? item.confirmed_by_user_id) : null,
      note: item?.note ?? null,
    };
  });
  const confirmed = items.filter((i) => i.confirmed).length;
  return { items, confirmed, total: GO_LIVE_ITEMS.length, complete: confirmed === GO_LIVE_ITEMS.length };
}

/** `month` is `YYYY-MM` (Brussels); usage rows of `v_ai_usage_month` plus the feature register. */
export async function getAiUsage(tx: DbOrTx, input: { month: string }) {
  const month = /^\d{4}-\d{2}$/.test(input.month) ? `${input.month}-01` : null;
  const usage = month
    ? rowsOf<{ feature: string; model: string; calls: number; cost_cents: string | number; input_tokens: string | number; output_tokens: string | number }>(
        await tx.execute(sql`select feature, model, calls, cost_cents, input_tokens, output_tokens from v_ai_usage_month where month = ${month}::timestamp order by feature, model`),
      ).map((r) => ({ feature: r.feature, model: r.model, calls: Number(r.calls), costCents: Number(r.cost_cents), inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens) }))
    : [];
  const register = AI_FEATURE_KEYS.map((key) => ({ key, ...AI_FEATURES[key] }));
  return { usage, register, totalCents: usage.reduce((s, u) => s + u.costCents, 0) };
}

/** Key versions per table, MFA coverage, locked accounts, backups and pentests (`/admin/system/security`). */
export async function getSecurityStatus(tx: DbOrTx) {
  const security = (await getSetting(tx, "security")) as Record<string, unknown> & { current_key_version: number };
  const versions: { table: string; keyVersion: number; rows: number }[] = [];
  const tables = rowsOf<{ name: string }>(
    await tx.execute(sql`select table_name as name from information_schema.tables where table_schema = current_schema() and table_name in ('person_sensitive_fields','form_sensitive_answers','activity_events')`),
  ).map((t) => t.name);
  const count = async (table: string, q: SQL) => {
    for (const r of rowsOf<{ v: number; n: number }>(await tx.execute(q))) versions.push({ table, keyVersion: Number(r.v), rows: Number(r.n) });
  };
  if (tables.includes("person_sensitive_fields")) await count("person_sensitive_fields", sql`select key_version as v, count(*)::int as n from person_sensitive_fields group by 1 order by 1`);
  if (tables.includes("form_sensitive_answers")) await count("form_sensitive_answers", sql`select key_version as v, count(*)::int as n from form_sensitive_answers group by 1 order by 1`);
  if (tables.includes("activity_events")) {
    await count("activity_events", sql`select coalesce((data->>'key_version')::int, 1) as v, count(*)::int as n from activity_events where is_sensitive group by 1 order by 1`);
  }
  await count("users", sql`select coalesce(secret_key_version, 1) as v, count(*)::int as n from users where totp_secret_enc is not null or recovery_codes_enc is not null group by 1 order by 1`);
  const [mfa] = rowsOf<{ total: number; enrolled: number; locked: number }>(
    await tx.execute(sql`select count(*)::int as total, count(mfa_enrolled_at)::int as enrolled, count(*) filter (where locked_until > now())::int as locked
      from users where audience = 'staff' and status = 'active'`),
  );
  const locked = await tx
    .select({ id: users.id, name: users.name, email: users.email, lockedUntil: users.lockedUntil })
    .from(users)
    .where(and(eq(users.audience, "staff"), sql`${users.lockedUntil} > now()`))
    .limit(50);
  return {
    currentKeyVersion: security.current_key_version,
    versions,
    mfa: { total: Number(mfa?.total ?? 0), enrolled: Number(mfa?.enrolled ?? 0), locked: Number(mfa?.locked ?? 0) },
    locked,
    lastBackupAt: (security.last_backup_at as string | null) ?? null,
    lastBackupOk: (security.last_backup_ok as boolean | null) ?? null,
    lastRestoreDrillAt: (security.last_restore_drill_at as string | null) ?? null,
    lastRestoreDrillOk: (security.last_restore_drill_ok as boolean | null) ?? null,
    lastPentestOn: (security.last_pentest_on as string | null) ?? null,
    nextPentestDueOn: (security.next_pentest_due_on as string | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Support register and monthly reports
// ---------------------------------------------------------------------------

export type SupportStatus = (typeof supportRequests.$inferSelect)["status"];
export type SupportRow = {
  id: string;
  reference: string;
  severity: (typeof supportRequests.$inferSelect)["severity"];
  channel: (typeof supportRequests.$inferSelect)["channel"];
  title: string;
  status: SupportStatus;
  receivedAt: Date;
  responseDueAt: Date;
  firstResponseAt: Date | null;
  resolvedAt: Date | null;
  isBreached: boolean;
  reporter: string | null;
  assignee: string | null;
  createdAt: Date;
};

export async function listSupportRequests(
  tx: DbOrTx,
  input: { status?: SupportStatus[]; severity?: SupportRow["severity"]; mineUserId?: string; cursor?: string | null } = {},
): Promise<{ rows: SupportRow[]; nextCursor: string | null }> {
  const where: SQL[] = [];
  if (input.status?.length) where.push(sql`s.status::text in ${input.status}`);
  if (input.severity) where.push(sql`s.severity = ${input.severity}`);
  if (input.mineUserId) where.push(sql`r.reported_by_user_id = ${input.mineUserId}`);
  const cursor = decodeCursor(input.cursor);
  if (cursor) where.push(sql`(r.created_at, r.id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`);
  const rows = rowsOf<Record<string, unknown>>(
    await tx.execute(sql`
      select s.id, s.reference, s.severity, s.status, s.received_at, s.response_due_at, s.first_response_at, s.resolved_at, s.is_breached,
             r.channel, r.title, r.created_at, coalesce(rep.name, rep.email) as reporter, coalesce(asg.name, asg.email) as assignee
      from v_support_sla s
      join support_requests r on r.id = s.id
      left join users rep on rep.id = r.reported_by_user_id
      left join users asg on asg.id = r.assignee_user_id
      ${where.length ? sql`where ${sql.join(where, sql` and `)}` : sql``}
      order by r.created_at desc, r.id desc
      limit ${PAGE_SIZE + 1}`),
  ).map(
    (r): SupportRow => ({
      id: String(r.id),
      reference: String(r.reference),
      severity: r.severity as SupportRow["severity"],
      channel: r.channel as SupportRow["channel"],
      title: String(r.title),
      status: r.status as SupportStatus,
      receivedAt: new Date(r.received_at as string),
      responseDueAt: new Date(r.response_due_at as string),
      firstResponseAt: r.first_response_at ? new Date(r.first_response_at as string) : null,
      resolvedAt: r.resolved_at ? new Date(r.resolved_at as string) : null,
      isBreached: !!r.is_breached,
      reporter: (r.reporter as string | null) ?? null,
      assignee: (r.assignee as string | null) ?? null,
      createdAt: new Date(r.created_at as string),
    }),
  );
  return page(rows);
}

export async function getSupportRequest(tx: DbOrTx, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await tx.select().from(supportRequests).where(eq(supportRequests.id, id));
  return row ?? null;
}

export async function listMonthlyReports(tx: DbOrTx) {
  return tx
    .select({ id: monthlyReports.id, monthOn: monthlyReports.monthOn, status: monthlyReports.status, data: monthlyReports.data, sentAt: monthlyReports.sentAt })
    .from(monthlyReports)
    .orderBy(desc(monthlyReports.monthOn))
    .limit(120);
}

export async function getMonthlyReport(tx: DbOrTx, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await tx
    .select({
      id: monthlyReports.id,
      monthOn: monthlyReports.monthOn,
      status: monthlyReports.status,
      data: monthlyReports.data,
      notes: monthlyReports.notes,
      sentAt: monthlyReports.sentAt,
      sentBy: users.name,
      updatedAt: monthlyReports.updatedAt,
    })
    .from(monthlyReports)
    .leftJoin(users, eq(users.id, monthlyReports.sentByUserId))
    .where(eq(monthlyReports.id, id));
  return row ?? null;
}

/** The `/admin/system` overview tiles. */
export async function getSystemOverview(tx: DbOrTx) {
  const [lastTickAt, jobStats, health, gate] = [await getSetting(tx, "last_tick_at"), await getJobStats(tx), await getIntegrationHealth(tx), await getGoLiveGate(tx)];
  const [counts] = rowsOf<{ dead: number; webhooks_24h: number; ai_cents: number; files_bytes: number; open_incidents: number; open_support: number; latest_uptime: number | null }>(
    await tx.execute(sql`select
      (select count(*)::int from jobs where status = 'dead') as dead,
      (select count(*)::int from webhook_events where received_at > now() - interval '24 hours') as webhooks_24h,
      (select coalesce(sum(cost_cents), 0)::float8 from ai_requests where created_at >= date_trunc('month', now() at time zone 'Europe/Brussels') at time zone 'Europe/Brussels') as ai_cents,
      (select coalesce(sum(size_bytes), 0)::float8 from files) as files_bytes,
      (select count(*)::int from security_incidents where status <> 'resolved') as open_incidents,
      (select count(*)::int from support_requests where status in ('open','responded')) as open_support,
      (select (data->>'uptime_pct')::float8 from monthly_reports order by month_on desc limit 1) as latest_uptime`),
  );
  const pending = jobStats.filter((s) => s.status === "pending");
  const oldest = pending.map((s) => s.oldest_pending_run_at).filter((v): v is string => !!v).sort()[0] ?? null;
  return {
    lastTickAt: (lastTickAt as string | null) ?? null,
    jobStats,
    oldestPendingRunAt: oldest,
    dead: Number(counts?.dead ?? 0),
    health,
    webhooks24h: Number(counts?.webhooks_24h ?? 0),
    aiSpendCents: Number(counts?.ai_cents ?? 0),
    filesBytes: Number(counts?.files_bytes ?? 0),
    openIncidents: Number(counts?.open_incidents ?? 0),
    openSupport: Number(counts?.open_support ?? 0),
    latestUptimePct: counts?.latest_uptime === null || counts?.latest_uptime === undefined ? null : Number(counts.latest_uptime),
    gate: { confirmed: gate.confirmed, total: gate.total },
  };
}

// ---------------------------------------------------------------------------
// Catalogue sections for the client forms
// ---------------------------------------------------------------------------

/**
 * The strings of one catalogue section (for example `platform.users`) as a flat record, so a
 * server page hands its client forms their labels in one prop. ICU templates stay raw; the
 * client fills parameters with `fill()`. Nested groups are flattened with `_`.
 */
export function catalogueSection(locale: Locale, section: string): Record<string, string> {
  const [module, ...path] = section.split(".");
  let node: unknown = MESSAGES[locale]?.[module ?? ""];
  for (const p of [module, ...path]) node = node && typeof node === "object" ? (node as Record<string, unknown>)[p ?? ""] : undefined;
  const out: Record<string, string> = {};
  const walk = (n: unknown, prefix: string) => {
    if (!n || typeof n !== "object") return;
    for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
      if (typeof v === "string") out[prefix + k] = v;
      else walk(v, `${prefix}${k}_`);
    }
  };
  walk(node, "");
  return out;
}

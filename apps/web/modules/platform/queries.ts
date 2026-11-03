/**
 * Platform read functions for its own screens (platform spec 4.3), the platform-P6 part:
 * the current user, own sessions, jobs (keyset-paginated, 50 rows, cursor `created_at,id`)
 * and the job detail with its provider calls. Explicit columns only.
 */
import type { DbOrTx } from "@beam/db";
import { authSessions, integrationCalls, jobs, users } from "@beam/db/schema";
import { redactForAudit } from "@/lib/audit";
import { and, desc, eq, lt, or, sql, type SQL } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";

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

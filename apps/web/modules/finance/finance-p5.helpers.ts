/**
 * Test helpers of the finance-P5 suites (actions, permissions, queries): staff and customer
 * sessions (the test file keeps the cookie jar behind its `next/headers` mock and stores the
 * returned token under `SESSION_COOKIE`), roles with their seeded grants, and small readers for
 * audit rows and jobs.
 */
import type { Db } from "@beam/db";
import { auditLog, jobs, roles, users, type RoleKey } from "@beam/db/schema";
import { makeUser } from "@beam/db/testing";
import { DEFAULT_ROLE_GRANTS } from "@beam/db/seed/platform";
import { createAuthSession, SESSION_COOKIE } from "@/lib/auth";
import { and, asc, eq, sql } from "@/lib/ctx";

export { SESSION_COOKIE };

/** A `next/headers` cookie store over `jar`. */
export function cookieStore(jar: Map<string, string>) {
  return Promise.resolve({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  });
}

/** Signs in a staff user of `roleKey` whose role carries the seeded grants (or `permissions`). */
export async function signInStaff(jar: Map<string, string>, db: Db, roleKey: RoleKey, permissions?: readonly string[]) {
  const user = await makeUser(db, { roleKey });
  const grants = permissions ?? (DEFAULT_ROLE_GRANTS as Partial<Record<RoleKey, readonly string[]>>)[roleKey] ?? [];
  await db.update(roles).set({ permissions: [...grants] }).where(eq(roles.key, roleKey));
  const { token } = await createAuthSession(db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

/** Signs in a customer; returns the user with its `personId`. */
export async function signInCustomer(jar: Map<string, string>, db: Db, personId?: string) {
  const [existing] = personId ? await db.select().from(users).where(and(eq(users.personId, personId), eq(users.audience, "customer"))) : [];
  const user = existing ?? (await makeUser(db, { audience: "customer", ...(personId ? { personId } : {}) }));
  const { token } = await createAuthSession(db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

/** Audit rows of `action` for `entityId` (all entities when omitted). */
export async function auditRows(db: Db, action: string, entityId?: string) {
  const rows = await db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.createdAt));
  return entityId ? rows.filter((r) => r.entityId === entityId) : rows;
}

/** Jobs whose idempotency key starts with `prefix`, oldest first. */
export async function jobsWithKeyPrefix(db: Db, prefix: string) {
  return db
    .select()
    .from(jobs)
    .where(and(sql`${jobs.idempotencyKey} like ${`${prefix}%`}`))
    .orderBy(asc(jobs.createdAt), asc(jobs.idempotencyKey));
}

/** Marks every job with key `key` dead (a permanently failed push). */
export async function killJob(db: Db, key: string): Promise<void> {
  await db.update(jobs).set({ status: "dead", finishedAt: new Date() }).where(eq(jobs.idempotencyKey, key));
}

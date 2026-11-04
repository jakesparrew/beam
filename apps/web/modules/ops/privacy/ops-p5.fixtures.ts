/**
 * Test helpers of the privacy suites (ops-P5): the export key, a driver that runs the privacy job
 * chain through the job runner (each job in its own transaction, like production), request rows
 * in a given state, customer and staff sessions through the mocked cookie jar, and a reader of
 * the store-only zip the download routes stream.
 */
import { inflateRawSync } from "node:zlib";
import type { Db, DbOrTx } from "@beam/db";
import { privacyRequests, roles } from "@beam/db/schema";
import { makePerson, makeUser } from "@beam/db/testing";
import { eq, sql } from "@/lib/ctx";
import { runJobs } from "@/lib/job-runner";
import { rowsOf } from "@/lib/sensitive";
import type { Integrations } from "@/lib/integrations";
import { createFakeIntegrations } from "@/lib/testing";

/** A fixed 32-byte test key for `SENSITIVE_DATA_KEY_V1` (never a real key). */
export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

export function useTestKey(): void {
  process.env.SENSITIVE_DATA_KEY_V1 = TEST_KEY;
}

/**
 * Runs due `privacy.*` jobs until none is due. Retries are pulled forward (backoff skipped);
 * `includeScheduled` also pulls the 24-hour start job forward.
 */
export async function drainPrivacy(db: Db, opts: { integrations?: Integrations; includeScheduled?: boolean; rounds?: number } = {}): Promise<void> {
  const integrations = opts.integrations ?? createFakeIntegrations();
  for (let i = 0; i < (opts.rounds ?? 200); i++) {
    if (opts.includeScheduled) await db.execute(sql`update jobs set run_at = now() where status = 'pending' and kind like 'privacy.%'`);
    else await db.execute(sql`update jobs set run_at = now() where status = 'pending' and kind like 'privacy.%' and attempts > 0`);
    const due = rowsOf<{ id: string }>(await db.execute(sql`select id::text as id from jobs where status = 'pending' and kind like 'privacy.%' and run_at <= now() order by priority, run_at`));
    if (!due.length) return;
    await runJobs({ db, ids: due.map((d) => d.id), budgetMs: 60_000, integrations });
  }
}

/** The privacy jobs of a request, by key. */
export async function privacyJobs(db: DbOrTx, requestId: string): Promise<{ kind: string; key: string; status: string; attempts: number; run_at: Date }[]> {
  return rowsOf(
    await db.execute(sql`select kind, idempotency_key as key, status::text as status, attempts, run_at from jobs where idempotency_key like ${`privacy:${requestId}:%`} order by created_at, idempotency_key`),
  );
}

export async function requestOf(db: DbOrTx, id: string) {
  const [row] = await db.select().from(privacyRequests).where(eq(privacyRequests.id, id));
  return row!;
}

/** A request row inserted directly in a given state (for transition tests). */
export async function seedRequest(db: DbOrTx, input: Partial<typeof privacyRequests.$inferInsert> & { personId: string; kind: (typeof privacyRequests.$inferInsert)["kind"] }) {
  const [row] = await db
    .insert(privacyRequests)
    .values({ requestedBy: "staff", dueOn: "2026-12-04", ...input })
    .returning();
  return row!;
}

/** A customer user with a person, signed in through the mocked jar. */
export async function signInCustomer(db: Db, jar: Map<string, string>, over: { locale?: "nl-BE" | "fr-BE" | "en"; email?: string } = {}) {
  const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
  const email = over.email ?? `customer-${Math.random().toString(36).slice(2)}@example.com`;
  const person = await makePerson(db, { email, locale: over.locale ?? "nl-BE" });
  const user = await makeUser(db, { audience: "customer", personId: person.id, email, locale: over.locale ?? "nl-BE" });
  const { token } = await createAuthSession(db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
  return { user, person };
}

/** A staff user of `roleKey` whose role has exactly `permissions`, signed in through the jar. */
export async function signInStaffWith(db: Db, jar: Map<string, string>, permissions: string[], roleKey: "management" | "technical_admin" | "customer_service" | "sales" = "technical_admin") {
  const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
  const user = await makeUser(db, { roleKey });
  await db.update(roles).set({ permissions }).where(eq(roles.key, roleKey));
  const { token } = await createAuthSession(db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

/** The `next/headers` mock of the action suites (one jar per file). */
export function headersMock(jar: Map<string, string>) {
  return {
    cookies: () =>
      Promise.resolve({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.20" })),
  };
}

/** Reads a store-only (or deflated) zip into named entries. */
export function unzip(bytes: Uint8Array): { name: string; bytes: Uint8Array; text: string }[] {
  const out: { name: string; bytes: Uint8Array; text: string }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip");
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let i = 0; i < entries; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    const lNameLen = view.getUint16(local + 26, true);
    const lExtraLen = view.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + size);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    out.push({ name, bytes: data, text: dec.decode(data).replace(/^\uFEFF/, "") });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

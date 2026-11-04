import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, ensureRole } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { jobs, users } from "@beam/db/schema";
import { like } from "drizzle-orm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.SENSITIVE_DATA_KEY_V2 ??= randomBytes(32).toString("base64");

const { encryptSensitive, sensitiveAad, rowsOf, REKEY_CHUNK } = await import("@/lib/sensitive");
const { readMfaSecrets } = await import("@/lib/auth");
const { sql } = await import("@/lib/ctx");
const { loadJobs } = await import("@/lib/job-runner");
const { makeJobCtx, resetRuntime } = await import("@/lib/testing");

let handle: DbHandle;
const TOTAL = REKEY_CHUNK + 20;
const secretOf = (id: string) => `SECRET${id.slice(0, 8).toUpperCase()}`;

beforeAll(async () => {
  handle = await createTestDb();
  await ensureRole(handle.db, "technical_admin");
  const rows = Array.from({ length: TOTAL }, (_, i) => {
    const id = randomUUID();
    return {
      id,
      audience: "staff" as const,
      email: `rekey-${i}-${id.slice(0, 6)}@example.com`,
      roleKey: "technical_admin" as const,
      totpSecretEnc: encryptSensitive(secretOf(id), sensitiveAad.totpSecret(id), 1).valueEnc,
      recoveryCodesEnc: encryptSensitive("[]", sensitiveAad.recoveryCodes(id), 1).valueEnc,
      secretKeyVersion: 1,
      mfaEnrolledAt: new Date(),
    };
  });
  for (let i = 0; i < rows.length; i += 200) await handle.db.insert(users).values(rows.slice(i, i + 200));
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

const versions = async () =>
  Object.fromEntries(
    rowsOf<{ v: number; n: number }>(await handle.db.execute(sql`select secret_key_version as v, count(*)::int as n from users group by 1 order by 1`)).map((r) => [r.v, r.n]),
  );

describe("security.rekey (PL-70, edge 19)", () => {
  it("moves rows on version 1 to version 2 in chunks of 500, and reads work mid-way", async () => {
    const def = (await loadJobs())["security.rekey"]!;
    const first = (await def.run(makeJobCtx(handle.db, "security.rekey"), { toVersion: 2, table: "users" })) as { rows: number; next: string | null };
    expect(first.rows).toBe(REKEY_CHUNK);
    expect(first.next).toMatch(/^rekey:2:users:[0-9a-f-]{36}$/);
    expect(await versions()).toEqual({ 1: 20, 2: REKEY_CHUNK });

    // Mid-way: rows on both versions decrypt with their own key version.
    const mixed = rowsOf<{ id: string; v: number }>(
      await handle.db.execute(sql`(select id::text as id, secret_key_version as v from users where secret_key_version = 1 limit 1)
        union all (select id::text as id, secret_key_version as v from users where secret_key_version = 2 limit 1)`),
    );
    expect(mixed.map((m) => m.v).sort()).toEqual([1, 2]);
    for (const m of mixed) expect((await readMfaSecrets(handle.db, m.id)).totpSecret).toBe(secretOf(m.id));

    // The follow-up chunk was enqueued with the last id of this chunk.
    const [next] = await handle.db.select().from(jobs).where(like(jobs.idempotencyKey, "rekey:2:users:%"));
    expect(next!.idempotencyKey).toBe(first.next);
    const second = (await def.run(makeJobCtx(handle.db, "security.rekey"), next!.payload as never)) as { rows: number; next: string | null };
    expect(second).toEqual({ rows: 20, next: null });
    expect(await versions()).toEqual({ 2: TOTAL });

    // A rerun changes nothing (idempotent).
    expect(await def.run(makeJobCtx(handle.db, "security.rekey"), { toVersion: 2, table: "users" })).toEqual({ rows: 0, next: null });
    const sample = rowsOf<{ id: string }>(await handle.db.execute(sql`select id::text as id from users limit 3`));
    for (const s of sample) expect((await readMfaSecrets(handle.db, s.id)).totpSecret).toBe(secretOf(s.id));
  });
});

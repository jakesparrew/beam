/** crm's demo seed (crm-P1): 40 persons, 5 companies, 10 tasks, idempotent on a second run. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { seedDefaults } from "@beam/db/seed";
import { emailHash } from "@beam/core/crm";
import { sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { runCrmDemoSeed } from "./seed";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  await seedDefaults(h.db);
});
afterAll(() => h.close());

const count = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number }>(await h.db.execute(q))[0]!.n);

describe("crm demo seed", () => {
  it("creates demo persons, companies and tasks and changes nothing on a second run", async () => {
    const owner = await makeUser(h.db, { roleKey: "owner" });
    const legacy = await makePerson(h.db, { email: "legacy-seed@example.com", phone: "0470 99 88 77" });
    const ids = new Map<string, string>([["platform.user.owner", owner.id]]);
    const now = new Date("2026-11-03T00:00:00Z");

    const first = await runCrmDemoSeed({ db: h.db, now, ids });
    expect(first.created).toBe(40 + 5 + 10);
    expect(await count(sql`select count(*)::int as n from persons where email like 'crm-demo-%@example.com' and is_tester and email_hash is not null`)).toBe(40);
    expect(await count(sql`select count(*)::int as n from companies`)).toBe(5);
    expect(await count(sql`select count(*)::int as n from tasks where dedupe_key like 'demo:task:%'`)).toBe(10);
    expect(await count(sql`select count(*)::int as n from company_contacts`)).toBeGreaterThan(0);
    expect(await count(sql`select count(*)::int as n from person_tags`)).toBeGreaterThan(0);
    expect(ids.get("crm.person.demo1")).toBeDefined();

    const [backfilled] = rowsOf<{ email_hash: string; phone_e164: string }>(await h.db.execute(sql`select email_hash, phone_e164 from persons where id = ${legacy.id}`));
    expect(backfilled).toEqual({ email_hash: emailHash("legacy-seed@example.com"), phone_e164: "+32470998877" });

    const second = await runCrmDemoSeed({ db: h.db, now, ids });
    expect(second.created).toBe(0);
    expect(await count(sql`select count(*)::int as n from tasks`)).toBe(10);
  });
});

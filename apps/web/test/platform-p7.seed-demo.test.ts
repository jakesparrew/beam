/**
 * The demo seed runner (`apps/web/scripts/seed-demo.ts`, platform-P7) with fixture seeds:
 * `after` order, idempotent second run, and the PL-79 / edge case 28 refusals. Platform's own
 * demo rows are platform-P6's `seed.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { persons, roles } from "@beam/db/schema";
import { eq, sql } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { rowsOf } from "@/lib/sensitive";
import { DEMO_SEEDS } from "@/registry/seeds.generated";
import {
  assertDemoAllowed,
  brusselsDayStart,
  DemoSeedRefusedError,
  parseProfile,
  runSeed,
  seededRandom,
  type DemoSeed,
  type SeedCtx,
} from "@/scripts/seed-demo";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

const count = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number }>(await handle.db.execute(q))[0]?.n ?? 0);

/** Fixture seeds: crm creates two tester persons by natural key, booking reads crm's ids. */
function fixtureSeeds(order: string[]): DemoSeed[] {
  const crm: DemoSeed = {
    module: "crm",
    after: ["platform"],
    run: async (s: SeedCtx) => {
      order.push("crm");
      for (const email of ["lotte.peeters@example.com", "jonas.claes@example.com"]) {
        await s.db.insert(persons).values({ email, firstName: "Demo", locale: "nl-BE", isTester: true, acquisition: { source: "manual" } }).onConflictDoNothing();
        const [row] = await s.db.select({ id: persons.id }).from(persons).where(eq(persons.email, email));
        s.ids.set(`crm.person.${email}`, row!.id);
      }
    },
  };
  const booking: DemoSeed = {
    module: "booking",
    after: ["crm"],
    run: (s: SeedCtx) => {
      order.push("booking");
      expect(s.ids.get("crm.person.lotte.peeters@example.com")).toBeTruthy();
      expect(s.ctx.actor.kind).toBe("system");
      expect(s.now.getTime()).toBe(brusselsDayStart(s.now).getTime());
      return Promise.resolve();
    },
  };
  return [crm, booking];
}

describe("seed-demo runner", () => {
  it("runs defaults, then the fixture seeds in after order, twice without error; the second run creates nothing", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const env = { APP_ENV: "local" };
    const first = await runSeed(handle.db, { profile: "demo", env, seeds: fixtureSeeds(order), runJobsAfter: true, jobsBudgetMs: 5_000, log: (l) => lines.push(l) });
    expect(first.defaults[0]).toBe("platform");
    expect(first.demo.map((d) => d.module)).toEqual(["crm", "booking"]);
    expect(first.demo[0]!.created).toBe(2);
    expect(await count(sql`select count(*)::int as n from roles`)).toBe(9);

    const second = await runSeed(handle.db, { profile: "demo", env, seeds: fixtureSeeds(order), runJobsAfter: false, log: (l) => lines.push(l) });
    expect(second.demo.every((d) => d.created === 0)).toBe(true);
    expect(order).toEqual(["crm", "booking", "crm", "booking"]);
    expect(lines.filter((l) => l.startsWith("crm:"))).toEqual(["crm: 2 created", "crm: 0 created"]);
  });

  it("role grants follow the generated permission registry", async () => {
    const [mgmt] = await handle.db.select().from(roles).where(eq(roles.key, "management"));
    expect(mgmt!.permissions).toContain("bookings.read");
    expect(mgmt!.permissions).not.toContain("users.manage");
  });

  it("runs the generated DEMO_SEEDS (the Wave 0 skeletons are no-ops)", async () => {
    const report = await runSeed(handle.db, { profile: "demo", env: { APP_ENV: "local" }, runJobsAfter: false, log: () => undefined });
    expect(report.demo.map((d) => d.module)).toEqual(DEMO_SEEDS.map((s) => s.module));
  });

  it("refuses APP_ENV=production before any write", async () => {
    const before = await count(sql`select count(*)::int as n from persons`);
    const seeds = fixtureSeeds([]);
    await expect(runSeed(handle.db, { profile: "demo", env: { APP_ENV: "production" }, seeds, log: () => undefined })).rejects.toBeInstanceOf(DemoSeedRefusedError);
    await handle.db.execute(sql`delete from persons where email like 'lotte.peeters%' or email like 'jonas.claes%'`);
    await expect(runSeed(handle.db, { profile: "demo", env: { APP_ENV: "production" }, seeds, log: () => undefined })).rejects.toThrow(/APP_ENV=production/);
    expect(await count(sql`select count(*)::int as n from persons`)).toBe(before - 2);
  });

  it("refuses when more than 500 persons are not testers", async () => {
    await assertDemoAllowed(handle.db, { APP_ENV: "local" });
    for (let i = 0; i < 501; i++) await makePerson(handle.db, { isTester: false });
    await expect(assertDemoAllowed(handle.db, { APP_ENV: "local" })).rejects.toThrow(/501 persons are not testers/);
    const before = await count(sql`select count(*)::int as n from persons`);
    await expect(runSeed(handle.db, { profile: "demo", env: { APP_ENV: "local" }, seeds: fixtureSeeds([]), log: () => undefined })).rejects.toBeInstanceOf(DemoSeedRefusedError);
    expect(await count(sql`select count(*)::int as n from persons`)).toBe(before);
    // The defaults profile still runs (deploys seed defaults on real databases).
    await expect(runSeed(handle.db, { profile: "defaults", env: { APP_ENV: "production" }, log: () => undefined })).resolves.toMatchObject({ demo: [] });
  });

  it("parses --profile and picks defaults in production", () => {
    expect(parseProfile(["--profile", "defaults"], {})).toBe("defaults");
    expect(parseProfile(["--profile=demo"], {})).toBe("demo");
    expect(parseProfile([], { APP_ENV: "production" })).toBe("defaults");
    expect(parseProfile([], { APP_ENV: "local" })).toBe("demo");
    expect(() => parseProfile(["--profile", "everything"], {})).toThrow();
  });

  it("the PRNG is deterministic", () => {
    const a = seededRandom(20261103);
    const b = seededRandom(20261103);
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});

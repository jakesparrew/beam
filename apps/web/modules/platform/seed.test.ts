import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import { seedDefaults } from "@beam/db/seed";
import type { DbHandle } from "@beam/db";
import { persons, settings, users } from "@beam/db/schema";
import { readMfaSecrets } from "@/lib/auth";
import { eq, sql } from "@/lib/ctx";
import { verifyPassword } from "@/lib/password";
import { generateTotp, generateTotpSecret, verifyTotp } from "@/lib/totp";
import { resetRuntime } from "@/lib/testing";
import { DEMO_COMPANY, DEMO_STAFF, demoPersons, runPlatformDemoSeed, seed } from "./seed";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
const TOTP = generateTotpSecret();
const env = { APP_ENV: "local", DEMO_STAFF_PASSWORD: "Demo-Staff-Password-2026!", DEMO_TOTP_SECRET: TOTP };

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
  await seedDefaults(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

describe("platform demo seed (DR-12, DR-14)", () => {
  it("is registered without dependencies", () => {
    expect(seed.after).toEqual([]);
    expect(typeof seed.run).toBe("function");
  });

  it("creates nine MFA-enrolled staff users, 20 test persons and five customer users", async () => {
    const result = await runPlatformDemoSeed({ tx: handle.db }, env);
    expect(result.created).toBeGreaterThanOrEqual(9 + 20 + 5);

    const staff = await handle.db.select().from(users).where(eq(users.audience, "staff"));
    expect(staff.map((u) => u.email).sort()).toEqual(DEMO_STAFF.map((s) => `${s.role}@demo.beam.be`).sort());
    const owner = staff.find((u) => u.roleKey === "owner")!;
    expect(owner).toMatchObject({ name: "Gaëtan Demo", locale: "nl-BE", isTester: true });
    expect(staff.find((u) => u.roleKey === "management")).toMatchObject({ locale: "fr-BE", isTester: false });
    expect(staff.find((u) => u.roleKey === "external_partner")!.personId).not.toBeNull();
    expect(await verifyPassword(env.DEMO_STAFF_PASSWORD, owner.passwordHash)).toBe(true);
    for (const u of staff) {
      expect(u.mfaEnrolledAt).not.toBeNull();
      const { totpSecret, codes } = await readMfaSecrets(handle.db, u.id);
      expect(totpSecret).toBe(TOTP);
      expect(codes).toHaveLength(10);
    }
    const now = new Date();
    expect(verifyTotp(TOTP, generateTotp(TOTP, now), now)).not.toBeNull();

    const people = await handle.db.select().from(persons).where(sql`${persons.email} like 'customer%@example.com'`);
    expect(people).toHaveLength(20);
    expect(people.every((p) => p.isTester)).toBe(true);
    expect(people.filter((p) => p.locale === "nl-BE")).toHaveLength(10);
    expect(people.filter((p) => p.locale === "fr-BE")).toHaveLength(6);
    expect(people.filter((p) => p.locale === "en")).toHaveLength(4);

    const customers = await handle.db.select().from(users).where(eq(users.audience, "customer"));
    expect(customers.map((c) => c.email).sort()).toEqual(demoPersons().slice(0, 5).map((p) => p.email).sort());
    const byEmail = new Map(people.map((p) => [p.email, p.id]));
    for (const c of customers) expect(c.personId).toBe(byEmail.get(c.email));

    const [company] = await handle.db.select().from(settings).where(eq(settings.key, "company"));
    expect(company!.value).toEqual(DEMO_COMPANY);
  });

  it("is idempotent: a second run creates nothing", async () => {
    const before = await handle.db.select({ id: users.id, hash: users.passwordHash }).from(users);
    const result = await runPlatformDemoSeed(handle.db, env);
    expect(result.created).toBe(0);
    const after = await handle.db.select({ id: users.id, hash: users.passwordHash }).from(users);
    expect(after).toEqual(before);
  });

  it("refuses production and missing demo secrets", async () => {
    await expect(runPlatformDemoSeed(handle.db, { ...env, APP_ENV: "production" })).rejects.toThrow(/production/);
    await expect(runPlatformDemoSeed(handle.db, { APP_ENV: "local" })).rejects.toThrow(/DEMO_STAFF_PASSWORD/);
  });
});

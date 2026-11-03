import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { ROLE_KEYS, roles } from "../src/schema/platform";
import { grantDefaultPermission, seedDefaults } from "../src/seed/run";
import {
  DEFAULT_ROLE_GRANTS,
  V1_PERMISSIONS,
  defaultRolesFor,
} from "../src/seed/platform";
import { createTestDb } from "../src/testing";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

const role = async (key: (typeof ROLE_KEYS)[number]) =>
  (await h.db.select().from(roles).where(eq(roles.key, key)))[0]!;

describe("platform defaults seed", () => {
  it("seeds the nine system roles with names in three locales", async () => {
    expect(await seedDefaults(h.db)).toEqual(["platform"]);
    const rows = await h.db.select().from(roles);
    expect(rows.map((r) => r.key).sort()).toEqual([...ROLE_KEYS].sort());
    for (const r of rows) {
      expect(r.isSystem).toBe(true);
      expect(Object.keys(r.name).sort()).toEqual(["en", "fr-BE", "nl-BE"]);
    }
  });

  it("gives the architecture's default role sets", async () => {
    expect((await role("owner")).permissions).toEqual(["*"]);
    const tech = await role("technical_admin");
    expect(tech.permissions).toContain("users.manage");
    expect(tech.permissions).not.toContain("persons.sensitive_read");
    expect(tech.permissions).toHaveLength(V1_PERMISSIONS.length - 1);
    const management = await role("management");
    for (const p of [
      "users.manage",
      "system.jobs",
      "privacy.run",
      "persons.sensitive_read",
    ]) {
      expect(management.permissions).not.toContain(p);
    }
    expect(management.permissions).toContain("settings.write");
    expect((await role("external_partner")).permissions).toEqual([
      "partner.own",
    ]);
    // referrals.manage (R3) is not in the V1 list, so finance and sales do not get it yet.
    expect((await role("finance")).permissions).not.toContain(
      "referrals.manage",
    );
    expect([...(await role("reception")).permissions].sort()).toEqual(
      [...DEFAULT_ROLE_GRANTS.reception].sort(),
    );
  });

  it("is idempotent on a second run", async () => {
    const before = await h.db.select().from(roles);
    await seedDefaults(h.db);
    const after = await h.db.select().from(roles);
    const strip = (rows: typeof before) =>
      rows
        .map((r) => ({
          key: r.key,
          permissions: r.permissions,
          seeded: r.seededPermissions,
          name: r.name,
        }))
        .sort((a, b) => a.key.localeCompare(b.key));
    expect(strip(after)).toEqual(strip(before));
  });

  it("grants a permission a later release adds, once, through the registry list", async () => {
    await seedDefaults(h.db, {
      permissions: [...V1_PERMISSIONS, "referrals.manage"],
    });
    expect((await role("finance")).permissions).toContain("referrals.manage");
    expect((await role("sales")).permissions).toContain("referrals.manage");
    expect((await role("management")).permissions).toContain(
      "referrals.manage",
    );
    expect((await role("marketing")).permissions).not.toContain(
      "referrals.manage",
    );
    expect(defaultRolesFor("referrals.manage").sort()).toEqual([
      "finance",
      "management",
      "sales",
      "technical_admin",
    ]);
  });

  it("does not re-grant a permission the owner removed (PL-80)", async () => {
    const reception = await role("reception");
    expect(reception.permissions).toContain("commerce.sell");
    await h.db
      .update(roles)
      .set({
        permissions: reception.permissions.filter((p) => p !== "commerce.sell"),
      })
      .where(eq(roles.key, "reception"));
    expect(
      await grantDefaultPermission(h.db, "reception", "commerce.sell"),
    ).toBe(false);
    await seedDefaults(h.db);
    const after = await role("reception");
    expect(after.permissions).not.toContain("commerce.sell");
    expect(after.seededPermissions).toContain("commerce.sell");
  });

  it("grantDefaultPermission adds a new permission once and records it", async () => {
    expect(
      await grantDefaultPermission(h.db, "marketing", "dashboards.manage"),
    ).toBe(true);
    expect(
      await grantDefaultPermission(h.db, "marketing", "dashboards.manage"),
    ).toBe(false);
    const marketing = await role("marketing");
    expect(
      marketing.permissions.filter((p) => p === "dashboards.manage"),
    ).toHaveLength(1);
    expect(
      marketing.seededPermissions.filter((p) => p === "dashboards.manage"),
    ).toHaveLength(1);
    // The owner keeps '{*}' (roles_owner_all_ck) and only gets the bookkeeping entry.
    expect(
      await grantDefaultPermission(h.db, "owner", "dashboards.manage"),
    ).toBe(false);
    expect((await role("owner")).permissions).toEqual(["*"]);
  });
});

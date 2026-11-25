import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrationsFolder } from "../src/testing";

/**
 * 0061_custom_roles on a database that holds the old enum roles and their users: every user
 * keeps its role, the four predefined roles get their new names, the other built-in roles
 * become editable, and a custom role can be added and assigned afterwards.
 */
const migrations = readMigrationFiles({ migrationsFolder });
const at = migrations.findIndex((m) => m.sql.some((s) => s.includes("DROP TYPE \"public\".\"roles_key\"")));
let pg: PGlite;
const rows = async <T>(q: string) => (await pg.query<T>(q)).rows;

beforeAll(async () => {
  expect(at).toBeGreaterThan(0);
  pg = new PGlite();
  for (const m of migrations.slice(0, at)) for (const s of m.sql) if (s.trim()) await pg.exec(s);
  const keys = ["owner", "management", "customer_service", "sales", "marketing", "finance", "reception", "technical_admin"];
  for (const key of keys) {
    const permissions = key === "owner" ? "{*}" : key === "management" ? "{persons.read,flags.manage,settings.write}" : "{persons.read}";
    await pg.query(`insert into roles (key, name, permissions, seeded_permissions) values ($1, '{"en":"x"}', $2, $2)`, [key, permissions]);
    await pg.query(`insert into users (audience, email, role_key) values ('staff', $1, $2)`, [`${key}@example.com`, key]);
  }
  for (const m of migrations.slice(at)) for (const s of m.sql) if (s.trim()) await pg.exec(s);
}, 120_000);
afterAll(() => pg?.close());

describe("0061_custom_roles", () => {
  it("keeps every staff user on its role", async () => {
    const users = await rows<{ email: string; role_key: string }>("select email, role_key from users order by email");
    for (const u of users) expect(u.email).toBe(`${u.role_key}@example.com`);
    expect(users).toHaveLength(8);
  });

  it("names the four predefined roles and keeps them system roles", async () => {
    const roles = await rows<{ key: string; en: string; is_system: boolean }>("select key, name->>'en' as en, is_system from roles");
    const byKey = new Map(roles.map((r) => [r.key, r]));
    expect(byKey.get("owner")).toMatchObject({ en: "Administrator", is_system: true });
    expect(byKey.get("management")).toMatchObject({ en: "Manager", is_system: true });
    expect(byKey.get("reception")).toMatchObject({ en: "Front Desk", is_system: true });
    expect(byKey.get("finance")).toMatchObject({ en: "Finance / Accounts", is_system: true });
    for (const k of ["customer_service", "sales", "marketing", "technical_admin"]) expect(byKey.get(k)?.is_system).toBe(false);
  });

  it("takes feature flags away from the Manager but remembers they were seeded", async () => {
    const [m] = await rows<{ permissions: string[]; seeded_permissions: string[] }>("select permissions, seeded_permissions from roles where key = 'management'");
    expect(m!.permissions).toEqual(["persons.read", "settings.write"]);
    expect(m!.seeded_permissions).toContain("flags.manage");
  });

  it("accepts a custom role, assigns it, and still refuses deleting a role in use", async () => {
    await pg.query(`insert into roles (key, name, permissions, is_system) values ('therapist', '{"en":"Therapist"}', '{bookings.read}', false)`);
    await pg.query(`insert into users (audience, email, role_key) values ('staff', 'therapist@example.com', 'therapist')`);
    await expect(pg.query("delete from roles where key = 'therapist'")).rejects.toThrow(/users_role_key_roles_key_fk/);
    await expect(pg.query(`insert into roles (key, name) values ('Bad Key', '{}')`)).rejects.toThrow(/roles_key_ck/);
    await expect(pg.query(`update roles set permissions = '{persons.read}' where key = 'owner'`)).rejects.toThrow(/roles_owner_all_ck/);
  });
});

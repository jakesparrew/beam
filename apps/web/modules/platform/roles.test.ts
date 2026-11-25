/**
 * Roles and access privileges (owner's review section 11): the permission matrix of the four
 * predefined roles through the real page guard, custom roles (create, permissions, assign,
 * rename, delete) and the audit rows every change writes.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import { seedDefaults } from "@beam/db/seed";
import type { DbHandle } from "@beam/db";
import { auditLog, roles, users, type RoleKey } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "roles-test-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.31" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/email/api", () => ({ sendTransactional: () => Promise.resolve({ emailMessageId: "m", jobId: "j" }) }));

const actions = await import("./actions");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { listRoles, roleKeyFor } = await import("./queries");
const { PERMISSIONS } = await import("@/registry/permissions.generated");

let handle: DbHandle;

async function signIn(roleKey: RoleKey) {
  const user = await makeUser(handle.db, { roleKey });
  const { token } = await auth.createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  return user;
}

/** True when the signed-in user gets past the page guard; `requireStaff` answers 404 otherwise. */
async function canOpen(permission: (typeof PERMISSIONS)[number]): Promise<boolean> {
  return auth.requireStaff({ permission }).then(
    () => true,
    (e: unknown) => {
      if (String((e as { digest?: string }).digest ?? e).includes("404")) return false;
      throw e;
    },
  );
}

const auditRows = (action: string, entityId: string) => handle.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
  await seedDefaults(handle.db, { permissions: PERMISSIONS });
}, 120_000);
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => jar.clear());

// Screen, the page that guards it, its permission, and who may open it:
// Administrator (owner), Manager (management), Front Desk (reception), Finance (finance).
const MATRIX = [
  ["financial reports", "finance/dashboard/page.tsx", "reports.finance", [true, true, false, true]],
  ["invoices", "finance/invoices/page.tsx", "invoices.read", [true, true, false, true]],
  ["technical logs (audit)", "system/audit/page.tsx", "system.jobs", [true, false, false, false]],
  ["technical logs (jobs)", "system/jobs/page.tsx", "system.jobs", [true, false, false, false]],
  ["feature flags", "settings/flags/page.tsx", "flags.manage", [true, false, false, false]],
  ["roles and users", "settings/roles/page.tsx", "users.manage", [true, false, false, false]],
  ["bookings", "bookings/page.tsx", "bookings.read", [true, true, true, false]],
  ["till (POS)", "pos/page.tsx", "commerce.sell", [true, true, true, false]],
  ["clients", "persons/page.tsx", "persons.read", [true, true, true, true]],
] as const;
const ROLES = ["owner", "management", "reception", "finance"] as const;

describe("the four predefined roles (who can open what)", () => {
  it.each(MATRIX)("%s (%s, %s)", async (_screen, page, permission, expected) => {
    const source = readFileSync(path.join(import.meta.dirname, "../../app/(admin)/admin", page), "utf8");
    expect(source).toContain(`"${permission}"`);
    for (const [i, role] of ROLES.entries()) {
      await signIn(role);
      expect(await canOpen(permission), `${role} on ${page}`).toBe(expected[i]);
    }
  });

  it("Front Desk never sees financial or sensitive data; Manager no technical or dangerous settings", async () => {
    const perms = async (key: string) => (await handle.db.select().from(roles).where(eq(roles.key, key)))[0]!.permissions;
    const frontDesk = await perms("reception");
    for (const p of ["reports.finance", "invoices.read", "commerce.refund", "pricing.write", "persons.sensitive_read"]) expect(frontDesk).not.toContain(p);
    const manager = await perms("management");
    for (const p of ["system.jobs", "users.manage", "flags.manage", "privacy.run", "persons.sensitive_read"]) expect(manager).not.toContain(p);
    const finance = await perms("finance");
    for (const p of ["invoices.read", "invoices.issue", "commerce.refund", "reports.finance"]) expect(finance).toContain(p);
    expect(await perms("owner")).toEqual(["*"]);
  });

  it("lists the predefined roles first, with their new names", async () => {
    const list = await listRoles(handle.db, "en");
    expect(list.slice(0, 4).map((r) => r.label)).toEqual(["Administrator", "Manager", "Front Desk", "Finance / Accounts"]);
    expect(list.slice(0, 4).every((r) => r.isSystem)).toBe(true);
  });
});

describe("custom roles", () => {
  it("derives a readable key from the name", () => {
    expect(roleKeyFor("Thérapeute senior")).toBe("therapeute_senior");
    expect(roleKeyFor("2nd desk")).toBe("role_2nd_desk");
    expect(roleKeyFor("!!")).toBe("role");
  });

  it("creates a role, gives it permissions, assigns it and the user gets exactly those rights", async () => {
    const admin = await signIn("owner");
    const created = await actions.createRole({ name: "Therapist", description: "Runs the sessions" });
    expect(created).toEqual({ ok: true, data: { roleKey: "therapist" } });
    expect(await actions.createRole({ name: "therapist" })).toMatchObject({ ok: false, error: { code: "conflict", message: "role_exists" } });
    expect(await actions.updateRolePermissions({ roleKey: "therapist", permissions: ["bookings.read", "persons.read"] })).toEqual({ ok: true, data: {} });
    const staff = await makeUser(handle.db, { roleKey: "reception" });
    expect(await actions.updateStaffUser({ userId: staff.id, roleKey: "therapist" })).toEqual({ ok: true, data: {} });
    expect(await actions.updateStaffUser({ userId: staff.id, roleKey: "no_such_role" })).toMatchObject({ ok: false, error: { code: "validation" } });

    const { token } = await auth.createAuthSession(handle.db, { userId: staff.id, audience: "staff", roleKey: "therapist", now: new Date(), mfaAt: new Date() });
    jar.set(auth.SESSION_COOKIE, token);
    expect(await canOpen("bookings.read")).toBe(true);
    expect(await canOpen("reports.finance")).toBe(false);

    for (const action of ["roles.create", "roles.update_permissions"]) expect(await auditRows(action, "therapist")).toHaveLength(1);
    const [change] = await auditRows("users.role_change", staff.id);
    expect(change).toMatchObject({ oldValue: { role_key: "reception" }, newValue: { role_key: "therapist" } });
    expect((change!.actor as { id?: string }).id).toBe(admin.id);
  });

  it("invites a new user straight into a custom role", async () => {
    await signIn("owner");
    await actions.createRole({ name: "Intern" });
    const invited = await actions.inviteStaffUser({ email: "intern@example.com", name: "Intern", roleKey: "intern", locale: "nl-BE" });
    expect(invited.ok).toBe(true);
    const [row] = await handle.db.select().from(users).where(eq(users.email, "intern@example.com"));
    expect(row!.roleKey).toBe("intern");
  });

  it("renames a custom role but never a predefined one", async () => {
    await signIn("owner");
    await actions.createRole({ name: "Cleaner" });
    expect(await actions.renameRole({ roleKey: "cleaner", name: "Housekeeping" })).toEqual({ ok: true, data: {} });
    const [row] = await handle.db.select().from(roles).where(eq(roles.key, "cleaner"));
    expect(row!.name).toEqual({ "nl-BE": "Housekeeping", "fr-BE": "Housekeeping", en: "Housekeeping" });
    expect(await auditRows("roles.rename", "cleaner")).toHaveLength(1);
    expect(await actions.renameRole({ roleKey: "reception", name: "Desk" })).toMatchObject({ ok: false, error: { code: "conflict", message: "system_role" } });
  });

  it("refuses to delete a role in use or a predefined role, and deletes an unused one", async () => {
    await signIn("owner");
    await actions.createRole({ name: "Temp" });
    const holder = await makeUser(handle.db, { roleKey: "temp", status: "disabled" });
    expect(await actions.deleteRole({ roleKey: "temp" })).toMatchObject({ ok: false, error: { code: "conflict", message: "role_in_use" } });
    expect(await actions.deleteRole({ roleKey: "management" })).toMatchObject({ ok: false, error: { code: "conflict", message: "system_role" } });
    await handle.db.update(users).set({ roleKey: "reception" }).where(eq(users.id, holder.id));
    expect(await actions.deleteRole({ roleKey: "temp" })).toEqual({ ok: true, data: {} });
    expect(await handle.db.select().from(roles).where(eq(roles.key, "temp"))).toHaveLength(0);
    expect(await auditRows("roles.delete", "temp")).toHaveLength(1);
  });

  it("a non-Administrator with user management cannot hand out a permission it lacks", async () => {
    await signIn("owner");
    await actions.createRole({ name: "Office lead" });
    await actions.updateRolePermissions({ roleKey: "office_lead", permissions: ["users.manage", "persons.read"] });
    await signIn("office_lead");
    await actions.createRole({ name: "Helper" });
    expect(await actions.updateRolePermissions({ roleKey: "helper", permissions: ["persons.read"] })).toEqual({ ok: true, data: {} });
    expect(await actions.updateRolePermissions({ roleKey: "helper", permissions: ["persons.read", "reports.finance"] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await actions.updateStaffUser({ userId: (await makeUser(handle.db, { roleKey: "helper" })).id, roleKey: "owner" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("keeps at least one active Administrator", async () => {
    await handle.db.update(users).set({ status: "disabled" }).where(eq(users.roleKey, "owner"));
    const last = await signIn("owner");
    expect(await actions.updateStaffUser({ userId: last.id, roleKey: "management" })).toMatchObject({ ok: false, error: { code: "conflict", message: "last_owner" } });
  });
});

/**
 * automation permissions (automation spec 7, automation-P5). The three strings are declared once
 * and reach the generated registry; the default roles follow the spec's table; every staff action
 * of this package is refused with `forbidden` without its permission, before anything is written
 * (no automation row changes, no audit row, no job); a customer session and no session are
 * `unauthorized`. The person controls (`automations.move_person`) are tested with automation-P6.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import { defaultRolesFor } from "@beam/db/seed/platform";
import type { DbHandle } from "@beam/db";
import { auditLog, automations, jobs, roles, segments } from "@beam/db/schema";
import type { RoleKey } from "@beam/db/schema";
import { permissions } from "./permissions";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.52" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { PERMISSIONS } = await import("@/registry/permissions.generated");
const { makeAutomation, makeGroup } = await import("./engine/automation-p2.fixtures");

let handle: DbHandle;
const sorted = (xs: readonly string[]) => [...xs].sort();

async function asStaff(roleKey: RoleKey, perms: readonly string[]) {
  const user = await makeUser(handle.db, { roleKey });
  await handle.db.update(roles).set({ permissions: [...perms] }).where(eq(roles.key, roleKey));
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
}

async function asCustomer() {
  const user = await makeUser(handle.db, { audience: "customer" });
  const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
}

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(() => jar.clear());

describe("declared permissions and default roles", () => {
  it("declares exactly the architecture's three strings, all in the generated registry", () => {
    expect(sorted(permissions)).toEqual(["automations.move_person", "automations.publish", "automations.write"]);
    for (const p of permissions) expect(PERMISSIONS).toContain(p);
  });

  it("marketing, technical_admin and management hold all three; customer_service, sales, reception, finance and external partners none", () => {
    for (const p of permissions) {
      for (const role of ["marketing", "technical_admin", "management"] as const) expect(defaultRolesFor(p), `${p} ${role}`).toContain(role);
      for (const role of ["customer_service", "sales", "reception", "finance", "external_partner"] as const) expect(defaultRolesFor(p), `${p} ${role}`).not.toContain(role);
    }
  });

  it("sales, customer_service and finance read the list through reports.read", () => {
    for (const role of ["sales", "customer_service", "finance"] as const) expect(defaultRolesFor("reports.read"), role).toContain(role);
  });
});

type Case = { name: string; permission: string; run: (ids: { automationId: string; slug: string; groupKey: string; segmentId: string }) => Promise<unknown> };

const CASES: Case[] = [
  { name: "createAutomation", permission: "automations.write", run: (i) => actions.createAutomation({ slug: `perm-${crypto.randomUUID().slice(0, 8)}`, name: "x", groupKey: i.groupKey, isMarketing: false }) },
  { name: "saveDraft", permission: "automations.write", run: (i) => actions.saveDraft({ automationId: i.automationId, definition: { changed: true }, name: "Changed" }) },
  { name: "publishVersion", permission: "automations.publish", run: (i) => actions.publishVersion({ automationId: i.automationId, migrateActive: true }) },
  { name: "activateAutomation", permission: "automations.publish", run: (i) => actions.activateAutomation({ automationId: i.automationId }) },
  { name: "pauseAutomation", permission: "automations.publish", run: (i) => actions.pauseAutomation({ automationId: i.automationId }) },
  { name: "resumeAutomation", permission: "automations.publish", run: (i) => actions.resumeAutomation({ automationId: i.automationId }) },
  { name: "archiveAutomation", permission: "automations.publish", run: (i) => actions.archiveAutomation({ automationId: i.automationId, confirmSlug: i.slug }) },
  { name: "enrolSegment", permission: "automations.publish", run: (i) => actions.enrolSegment({ automationId: i.automationId, segmentId: i.segmentId }) },
];

describe("every action is refused without its permission", () => {
  for (const c of CASES) {
    it(`${c.name} needs ${c.permission}`, async () => {
      const group = await makeGroup(handle.db);
      const a = await makeAutomation(handle.db, { group });
      const [segment] = await handle.db.insert(segments).values({ name: `perm ${c.name}`, kind: "static" }).returning();
      const ids = { automationId: a.id, slug: a.slug, groupKey: group.key, segmentId: segment!.id };
      const others = permissions.filter((p) => p !== c.permission);
      const auditsBefore = (await handle.db.select().from(auditLog)).length;
      const jobsBefore = (await handle.db.select().from(jobs)).length;
      const countBefore = (await handle.db.select().from(automations)).length;

      // Everything else this module declares, plus reading, is not enough.
      await asStaff("customer_service", [...others, "reports.read", "persons.read"]);
      expect(await c.run(ids)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      await asCustomer();
      expect(await c.run(ids)).toMatchObject({ ok: false, error: { code: "unauthorized" } });
      jar.clear();
      expect(await c.run(ids)).toMatchObject({ ok: false, error: { code: "unauthorized" } });

      const [row] = await handle.db.select().from(automations).where(eq(automations.id, a.id));
      expect(row).toMatchObject({ status: a.status, name: a.name, draftDefinition: a.draftDefinition, currentVersionId: a.currentVersionId });
      expect((await handle.db.select().from(automations)).length).toBe(countBefore);
      expect((await handle.db.select().from(auditLog)).length).toBe(auditsBefore);
      expect((await handle.db.select().from(jobs)).length).toBe(jobsBefore);

      // With the permission the same call gets past the check (it may still fail its own rules).
      await asStaff("marketing", [c.permission]);
      const r = (await c.run(ids)) as { ok: boolean; error?: { code: string } };
      expect(r.ok || !["forbidden", "unauthorized"].includes(r.error!.code), JSON.stringify(r)).toBe(true);
    });
  }
});

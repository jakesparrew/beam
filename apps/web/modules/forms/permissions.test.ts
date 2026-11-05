/**
 * forms-P5 action permissions (forms spec section 7): every staff action of forms-P5 is refused
 * with `forbidden` without its permission, before anything is written. Marketing (default grants:
 * `forms.write` and `forms.publish`) passes the check; reception (no forms permission) is refused
 * everywhere; a role with `forms.write` only cannot publish, archive, unarchive or delete. A
 * customer session and no session are `unauthorized`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import { DEFAULT_ROLE_GRANTS } from "@beam/db/seed/platform";
import type { DbHandle } from "@beam/db";
import { auditLog, forms, roles, type RoleKey } from "@beam/db/schema";
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
const { setAppDb, eq } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { T, lead, setupEnv, uniqueSlug, createForm: insertForm } = await import("./forms-p3.fixtures");

let h: DbHandle;
let formId: string;
let versionId: string;
let linkId: string;

async function asStaff(roleKey: RoleKey, perms: readonly string[]) {
  const user = await makeUser(h.db, { roleKey });
  await h.db.update(roles).set({ permissions: [...perms] }).where(eq(roles.key, roleKey));
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

const WRITE = ["createForm", "updateFormMeta", "saveDraft", "createDraft", "discardDraft", "duplicateForm", "createLink", "updateLink"] as const;
const PUBLISH = ["publishVersion", "archiveForm", "unarchiveForm", "deleteForm"] as const;
type Name = (typeof WRITE)[number] | (typeof PUBLISH)[number];

function calls(): Record<Name, () => Promise<unknown>> {
  const c = lead();
  return {
    createForm: () => actions.createForm({ slug: uniqueSlug("perm"), kind: "lead", name: T("Perm"), locales: ["nl-BE"] }),
    updateFormMeta: () => actions.updateFormMeta({ formId, name: T("Renamed") }),
    saveDraft: () => actions.saveDraft({ formId, versionId, definition: c.definition, scoring: c.scoring, locales: c.locales, expectedHash: "stale" }),
    createDraft: () => actions.createDraft({ formId }),
    discardDraft: () => actions.discardDraft({ formId, versionId: randomUUID() }),
    duplicateForm: () => actions.duplicateForm({ formId, newSlug: uniqueSlug("dup"), name: T("Copy") }),
    createLink: () => actions.createLink({ formId, name: "Flyer", channel: "print" }),
    updateLink: () => actions.updateLink({ linkId, isActive: false }),
    publishVersion: () => actions.publishVersion({ formId, versionId: randomUUID(), changeNote: "Go" }),
    archiveForm: () => actions.archiveForm({ formId: randomUUID() }),
    unarchiveForm: () => actions.unarchiveForm({ formId: randomUUID() }),
    deleteForm: () => actions.deleteForm({ formId: randomUUID() }),
  };
}

const forbidden = { ok: false, error: { code: "forbidden" } };

beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
  setAppDb(h.db);
  const c = lead();
  const f = await insertForm(h.db, c);
  formId = f.formId;
  versionId = f.versionId;
  const owner = await makeUser(h.db, { roleKey: "marketing" });
  const { formLinks } = await import("@beam/db/schema");
  const [l] = await h.db.insert(formLinks).values({ formId, key: "perm0001", name: "Seed", createdByUserId: owner.id }).returning();
  linkId = l!.id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

describe("forms action permissions", () => {
  it("registers forms.write and forms.publish", () => {
    expect(permissions).toEqual(expect.arrayContaining(["forms.write", "forms.publish"]));
  });

  it("marketing (default grants) passes every permission check", async () => {
    await asStaff("marketing", DEFAULT_ROLE_GRANTS.marketing);
    for (const [name, run] of Object.entries(calls())) {
      const r = (await run()) as { ok: boolean; error?: { code: string } };
      expect(r.ok ? "ok" : r.error!.code, name).not.toBe("forbidden");
    }
  });

  it("reception is refused every forms action and nothing is written", async () => {
    expect(DEFAULT_ROLE_GRANTS.reception).not.toContain("forms.write");
    await asStaff("reception", DEFAULT_ROLE_GRANTS.reception);
    const before = (await h.db.select().from(forms)).length;
    const audits = (await h.db.select().from(auditLog)).length;
    for (const [name, run] of Object.entries(calls())) expect(await run(), name).toMatchObject(forbidden);
    expect((await h.db.select().from(forms)).length).toBe(before);
    expect((await h.db.select().from(auditLog)).length).toBe(audits);
  });

  it("publish, archive, unarchive and delete need forms.publish", async () => {
    await asStaff("sales", ["forms.write"]);
    const all = calls();
    for (const name of PUBLISH) expect(await all[name](), name).toMatchObject({ ok: false, error: { code: "forbidden", message: "forbidden: forms.publish" } });
    for (const name of WRITE) {
      const r = (await all[name]()) as { ok: boolean; error?: { code: string } };
      expect(r.ok ? "ok" : r.error!.code, name).not.toBe("forbidden");
    }
  });

  it("a customer and an anonymous visitor are unauthorized", async () => {
    const customer = await makeUser(h.db, { audience: "customer" });
    const { token } = await createAuthSession(h.db, { userId: customer.id, audience: "customer", roleKey: null, now: new Date() });
    jar.set(SESSION_COOKIE, token);
    expect(await actions.createForm({ slug: uniqueSlug("x"), kind: "lead", name: T("X"), locales: ["nl-BE"] })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    jar.clear();
    expect(await actions.publishVersion({ formId, versionId, changeNote: "Go" })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });
});

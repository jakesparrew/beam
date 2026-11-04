/**
 * crm-P3 guardian consent (crm rule 3.54, cross-module D15) on a PGlite database: the actions
 * through `action()` with a signed-in owner, `hasValidDeclaration` against a mocked
 * `site.getCurrentLegalVersion`, and the append-only table.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, auditLog, personDeclarations } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p3-declarations-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.41" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const legal = vi.hoisted(() => ({ current: null as null | { versionId: string; version: number; requiresReacceptance: boolean } }));
vi.mock("@/modules/site/api", () => ({
  getCurrentLegalVersion: (_db: unknown, key: string) =>
    Promise.resolve(key === "guardian_consent" && legal.current ? { ...legal.current, publishedAt: new Date(), text: { en: "I consent" }, urlByLocale: {} } : null),
}));

const actions = await import("./actions");
const api = await import("./api");
const queries = await import("./queries");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");

let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  legal.current = { versionId: randomUUID(), version: 1, requiresReacceptance: false };
  const owner = await makeUser(h.db, { roleKey: "owner" });
  const { token } = await auth.createAuthSession(h.db, { userId: owner.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
});

const minorAndGuardian = async () => ({ minor: await makePerson(h.db, { birthOn: "2014-03-02" }), guardian: await makePerson(h.db, { birthOn: "1985-06-01" }) });
const valid = (personId: string) => api.hasValidDeclaration(h.db, { personId, kind: "guardian_consent" });

describe("guardian consent (rule 3.54)", () => {
  it("3.54 records a guardian_consent for the current published version with the guardian person", async () => {
    const { minor, guardian } = await minorAndGuardian();
    const out = await actions.recordDeclaration({ personId: minor.id, kind: "guardian_consent", guardianPersonId: guardian.id });
    expect(out.ok).toBe(true);
    const [row] = await h.db.select().from(personDeclarations).where(eq(personDeclarations.personId, minor.id));
    expect(row).toMatchObject({ kind: "guardian_consent", status: "accepted", method: "reception", documentVersionId: legal.current!.versionId, documentVersion: 1, guardianPersonId: guardian.id });
    expect(await valid(minor.id)).toBe(true);
    const [event] = await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, minor.id), eq(activityEvents.kind, "declaration.accepted")));
    expect(event!.data).toEqual({ kind: "guardian_consent", document_version: 1, method: "reception" });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "declaration.record"), eq(auditLog.personId, minor.id)))).toHaveLength(1);
    const list = await queries.listPersonDeclarations(h.db, minor.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.guardianName).toContain("Test");
  });

  it("3.54 refuses any other kind, a missing published version and the person as their own guardian", async () => {
    const { minor, guardian } = await minorAndGuardian();
    expect(await actions.recordDeclaration({ personId: minor.id, kind: "terms", guardianPersonId: guardian.id })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.recordDeclaration({ personId: minor.id, kind: "health_declaration", guardianPersonId: guardian.id })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.recordDeclaration({ personId: minor.id, kind: "guardian_consent", guardianPersonId: minor.id })).toMatchObject({ ok: false, error: { code: "validation" } });
    legal.current = null;
    expect(await actions.recordDeclaration({ personId: minor.id, kind: "guardian_consent", guardianPersonId: guardian.id })).toMatchObject({
      ok: false,
      error: { code: "validation", message: "no_published_version" },
    });
    expect(await h.db.select().from(personDeclarations).where(eq(personDeclarations.personId, minor.id))).toHaveLength(0);
    expect(await api.hasValidDeclaration(h.db, { personId: minor.id, kind: "terms" as "guardian_consent" })).toBe(false);
  });

  it("3.54 revoke appends a revoked row; a second revoke is a conflict", async () => {
    const { minor, guardian } = await minorAndGuardian();
    await actions.recordDeclaration({ personId: minor.id, kind: "guardian_consent", guardianPersonId: guardian.id });
    const revoked = await actions.revokeDeclaration({ personId: minor.id, kind: "guardian_consent", reason: "Guardian asked" });
    expect(revoked.ok).toBe(true);
    const rows = await queries.listPersonDeclarations(h.db, minor.id);
    expect(rows.map((r) => r.status)).toEqual(["revoked", "accepted"]);
    expect(await valid(minor.id)).toBe(false);
    expect(await actions.revokeDeclaration({ personId: minor.id, kind: "guardian_consent", reason: "Again" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "declaration.revoke"), eq(auditLog.personId, minor.id)))).toHaveLength(1);
  });

  it("3.54 a new version that requires re-acceptance invalidates earlier acceptances at once; one that does not keeps them", async () => {
    const { minor, guardian } = await minorAndGuardian();
    await actions.recordDeclaration({ personId: minor.id, kind: "guardian_consent", guardianPersonId: guardian.id });
    expect(await valid(minor.id)).toBe(true);
    legal.current = { versionId: randomUUID(), version: 2, requiresReacceptance: false };
    expect(await valid(minor.id)).toBe(true);
    legal.current = { versionId: randomUUID(), version: 3, requiresReacceptance: true };
    expect(await valid(minor.id)).toBe(false);
    await actions.recordDeclaration({ personId: minor.id, kind: "guardian_consent", guardianPersonId: guardian.id });
    expect(await valid(minor.id)).toBe(true);
  });

  it("3.54 person_declarations is append-only", async () => {
    const { minor, guardian } = await minorAndGuardian();
    await actions.recordDeclaration({ personId: minor.id, kind: "guardian_consent", guardianPersonId: guardian.id });
    await expect(h.db.update(personDeclarations).set({ status: "revoked" }).where(eq(personDeclarations.personId, minor.id))).rejects.toThrow();
    await expect(h.db.delete(personDeclarations).where(eq(personDeclarations.personId, minor.id))).rejects.toThrow();
  });

  it("3.54 a merged minor resolves to the winner", async () => {
    const { minor, guardian } = await minorAndGuardian();
    await actions.recordDeclaration({ personId: minor.id, kind: "guardian_consent", guardianPersonId: guardian.id });
    const loser = await makePerson(h.db, { mergedIntoPersonId: minor.id });
    expect(await valid(loser.id)).toBe(true);
    expect(await valid(randomUUID())).toBe(false);
  });
});

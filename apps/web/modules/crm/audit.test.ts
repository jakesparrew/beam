/**
 * crm-P7 audit (crm spec 7): each audited staff action writes its `audit_log` row with the staff
 * actor and its new value (and the old value where the action changes an existing value);
 * `note.add` carries no body; `sensitive.read` and `sensitive.write` rows carry keys only.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, consentWordings, personDuplicateCandidates } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p7-audit-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.90" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const legal = vi.hoisted(() => ({ versionId: "00000000-0000-4000-8000-000000000001" }));
vi.mock("@/modules/site/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getCurrentLegalVersion: (_db: unknown, key: string) =>
    Promise.resolve(key === "guardian_consent" ? { versionId: legal.versionId, version: 1, requiresReacceptance: true, publishedAt: new Date(), text: { en: "I consent" }, urlByLocale: {} } : null),
}));
vi.mock("@/modules/webinar/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mergePersons: () => Promise.resolve({ moved: 0, collapsed: 0 }),
}));
vi.mock("@/modules/automation/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestSuppressionExit: () => Promise.resolve({ jobId: null }),
  isSegmentInUse: () => Promise.resolve(false),
}));

const actions = await import("./actions");
const fixtures = await import("./segments/test-fixtures");
const auth = await import("@/lib/auth");
const { and, desc, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
let owner: { id: string };

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await fixtures.ensurePersonProfileView(h.db);
  for (const purpose of ["newsletter", "events", "member_comms", "b2b"] as const) {
    await h.db.insert(consentWordings).values({ purpose, version: 1, text: { en: purpose, "nl-BE": purpose, "fr-BE": purpose }, publishedAt: new Date("2026-01-01T00:00:00Z") }).onConflictDoNothing();
  }
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  owner = await makeUser(h.db, { roleKey: "owner" });
  const { token } = await auth.createAuthSession(h.db, { userId: owner.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
});

type Row = typeof auditLog.$inferSelect;

/** The latest audit row of `action` written by the signed-in owner. */
async function latest(action: string, opts: { newValue?: boolean } = {}): Promise<Row> {
  const rows = await h.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.createdAt), desc(auditLog.id));
  const mine = rows.filter((r) => (r.actor as { id?: string }).id === owner.id);
  expect(mine.length, `${action} audit row`).toBeGreaterThan(0);
  const row = mine[0]!;
  expect(row.actor).toMatchObject({ kind: "staff", id: owner.id });
  expect(row.createdAt).toBeInstanceOf(Date);
  if (opts.newValue !== false) expect(row.newValue, `${action} new value`).not.toBeNull();
  return row;
}

const ok = <T>(r: { ok: boolean; data?: unknown; error?: unknown }): T => {
  expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
  return (r as { data: T }).data;
};
const uniq = () => randomUUID().slice(0, 8);
const NAME = { en: "Breathwork", "nl-BE": "Ademwerk", "fr-BE": "Respiration" };

describe("crm audit rows (spec 7)", () => {
  it("person.create, person.update, person.acquisition and person.status_override", async () => {
    const { personId } = ok<{ personId: string }>(await actions.createPerson({ lastName: `Audit ${uniq()}`, locale: "nl-BE", acquisition: { source: "manual" }, confirmDuplicates: true }));
    expect((await latest("person.create")).entityId).toBe(personId);

    const p = await makePerson(h.db);
    ok(await actions.updatePerson({ personId: p.id, version: p.version, patch: { firstName: "Changed" } }));
    expect((await latest("person.update")).personId).toBe(p.id);

    const empty = await makePerson(h.db, { acquisition: {} });
    ok(await actions.fillAcquisition({ personId: empty.id, acquisition: { source: "event" } }));
    const acq = await latest("person.acquisition");
    expect(acq.oldValue).not.toBeUndefined();
    expect(acq.newValue).toMatchObject({ source: "event" });

    const s = await makePerson(h.db);
    ok(await actions.setStatusOverride({ personId: s.id, status: "customer", reason: "Paid in cash at the desk" }));
    const ov = await latest("person.status_override");
    expect(ov.personId).toBe(s.id);
  });

  it("note.add has no body and interaction.log has none of the summary text", async () => {
    const p = await makePerson(h.db);
    const body = `private remark ${uniq()}`;
    ok(await actions.addNote({ personId: p.id, body, isSensitive: false }));
    const note = await latest("note.add");
    expect(JSON.stringify(note)).not.toContain(body);
    expect(note.oldValue).toBeNull();

    ok(await actions.addNote({ personId: p.id, body, isSensitive: true }));
    expect(JSON.stringify(await latest("note.add"))).not.toContain(body);

    ok(await actions.logInteraction({ personId: p.id, channel: "call", purpose: "service", summary: "Called about a refund" }));
    const inter = await latest("interaction.log");
    expect(inter.newValue).toMatchObject({ channel: "call", purpose: "service" });
  });

  it("tag.create, tag.update, tag.assign and tag.delete", async () => {
    const { id } = ok<{ id: string }>(await actions.createTag({ key: `audit-${uniq()}`, name: NAME, color: "#112233" }));
    await latest("tag.create");
    ok(await actions.updateTag({ id, key: `audit-${uniq()}`, name: { ...NAME, en: "Breath" }, color: "#445566" }));
    const upd = await latest("tag.update");
    expect(upd.oldValue).not.toBeNull();
    const p = await makePerson(h.db);
    ok(await actions.tagPersons({ tagId: id, personIds: [p.id] }));
    expect((await latest("tag.assign")).newValue).toMatchObject({ added: 1 });
    ok(await actions.deleteTag({ id }));
    expect((await latest("tag.delete", { newValue: false })).oldValue).not.toBeNull();
  });

  it("consent.change, suppression.add and consent_wording.publish", async () => {
    const email = `audit-${uniq()}@example.com`;
    const p = await makePerson(h.db, { email, emailHash: emailHash(email) });
    ok(await actions.recordStaffConsent({ personId: p.id, purpose: "b2b", status: "granted" }));
    await latest("consent.change");
    ok(await actions.addManualSuppression({ email, scope: "newsletter", note: "Asked by phone" }));
    expect((await latest("suppression.add")).newValue).toMatchObject({ scope: "newsletter" });
    ok(await actions.publishConsentWording({ purpose: "events", text: { en: "Events v2", "nl-BE": "Evenementen v2", "fr-BE": "Événements v2" } }));
    await latest("consent_wording.publish");
  });

  it("sensitive.write and sensitive.read carry keys only", async () => {
    const p = await makePerson(h.db);
    const value = `insomnia ${uniq()}`;
    ok(await actions.setSensitiveField({ personId: p.id, key: "sleep", value }));
    const write = await latest("sensitive.write");
    expect(write.newValue).toEqual({ key: "sleep", changed: true });
    expect(JSON.stringify(write)).not.toContain(value);
    expect(ok<{ fields: Record<string, string> }>(await actions.revealSensitive({ personId: p.id, keys: ["sleep"] })).fields.sleep).toBe(value);
    const read = await latest("sensitive.read");
    expect(JSON.stringify(read)).not.toContain(value);
    expect(JSON.stringify(read.newValue)).toContain("sleep");
  });

  it("declaration.record and declaration.revoke", async () => {
    const minor = await makePerson(h.db, { birthOn: "2015-05-05" });
    const guardian = await makePerson(h.db, { birthOn: "1980-05-05" });
    ok(await actions.recordDeclaration({ personId: minor.id, kind: "guardian_consent", guardianPersonId: guardian.id }));
    expect((await latest("declaration.record")).personId).toBe(minor.id);
    ok(await actions.revokeDeclaration({ personId: minor.id, kind: "guardian_consent", reason: "Guardian asked" }));
    await latest("declaration.revoke");
  });

  it("person.duplicate_dismiss and person.merge", async () => {
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    const [x, y] = [a.id, b.id].sort();
    const [cand] = await h.db.insert(personDuplicateCandidates).values({ personAId: x!, personBId: y!, score: 70, reasons: ["name_birth"] }).returning();
    ok(await actions.dismissDuplicate({ candidateId: cand!.id }));
    await latest("person.duplicate_dismiss");

    const w = await makePerson(h.db);
    const l = await makePerson(h.db);
    ok(await actions.mergePersons({ winnerId: w.id, loserId: l.id, winnerVersion: w.version, loserVersion: l.version, fieldChoices: {} }));
    const merge = await latest("person.merge");
    expect(merge.oldValue).not.toBeNull();
  });

  it("segment.save, segment.members and segment.archive", async () => {
    const { id } = ok<{ id: string }>(await actions.saveSegment({ name: `Audit ${uniq()}`, kind: "static", definition: { op: "and", rules: [] }, excludeSegmentIds: [] }));
    await latest("segment.save");
    const p = await makePerson(h.db);
    ok(await actions.setStaticMembers({ segmentId: id, add: [p.id], remove: [] }));
    expect((await latest("segment.members")).newValue).toMatchObject({ added: 1 });
    ok(await actions.archiveSegment({ id }));
    expect((await latest("segment.archive")).oldValue).toEqual({ isArchived: false });
  });

  it("task.save and task.status", async () => {
    const { taskId: id } = ok<{ taskId: string }>(await actions.createTask({ title: "Send the proposal", kind: "proposal", priority: "high", ownerUserId: owner.id }));
    await latest("task.save");
    ok(await actions.completeTask({ id }));
    await latest("task.status");
  });

  it("company.save, company.contact_link and company.contact_update", async () => {
    const { companyId } = ok<{ companyId: string }>(await actions.saveCompany({ name: `Audit Co ${uniq()}`, status: "target", isPartner: false }));
    await latest("company.save");
    const p = await makePerson(h.db);
    const { contactId } = ok<{ contactId: string }>(await actions.linkContact({ companyId, personId: p.id, position: "HR", isPrimary: false }));
    await latest("company.contact_link");
    ok(await actions.updateContact({ contactId, position: "CEO" }));
    await latest("company.contact_update");
    const rows = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "company.contact_update"), eq(auditLog.entityId, contactId)));
    expect(rows.length).toBeGreaterThan(0);
  });
});

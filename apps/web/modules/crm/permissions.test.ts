/**
 * crm-P7 permissions (crm spec 4.1, 7): every crm staff action refuses a staff user who lacks its
 * permission (and a customer session), every customer action refuses staff, and customer
 * actions act only on the signed-in customer's own person whatever id the input names.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { consentRecords, consentWordings, persons, roles } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p7-permissions-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.77" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/automation/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestSuppressionExit: () => Promise.resolve({ jobId: null }),
}));

const actions = await import("./actions");
const timeline = await import("./timeline/actions");
const auth = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { PERMISSIONS } = await import("@/registry/permissions.generated");

let h: DbHandle;

type Call = (raw: unknown) => Promise<{ ok: boolean; error?: { code: string } }>;

/** Each staff action with the permission crm spec 4.1 gives it. */
const STAFF_ACTIONS: Array<[string, Call, string]> = [
  ["createPerson", actions.createPerson, "persons.write"],
  ["updatePerson", actions.updatePerson, "persons.write"],
  ["fillAcquisition", actions.fillAcquisition, "persons.write"],
  ["setStatusOverride", actions.setStatusOverride, "persons.write"],
  ["confirmStatusOverride", actions.confirmStatusOverride, "persons.write"],
  ["createTag", actions.createTag, "persons.write"],
  ["updateTag", actions.updateTag, "persons.write"],
  ["deleteTag", actions.deleteTag, "persons.write"],
  ["tagPersons", actions.tagPersons, "persons.write"],
  ["untagPersons", actions.untagPersons, "persons.write"],
  ["recordStaffConsent", actions.recordStaffConsent, "persons.write"],
  ["addManualSuppression", actions.addManualSuppression, "persons.write"],
  ["publishConsentWording", actions.publishConsentWording, "settings.write"],
  ["recordDeclaration", actions.recordDeclaration, "persons.write"],
  ["revokeDeclaration", actions.revokeDeclaration, "persons.write"],
  ["dismissDuplicate", actions.dismissDuplicate, "persons.merge"],
  ["mergePersons", actions.mergePersons, "persons.merge"],
  ["setSensitiveField", actions.setSensitiveField, "persons.sensitive_read"],
  ["revealSensitive", actions.revealSensitive, "persons.sensitive_read"],
  ["saveSegment", actions.saveSegment, "email.write"],
  ["archiveSegment", actions.archiveSegment, "email.write"],
  ["setStaticMembers", actions.setStaticMembers, "email.write"],
  ["refreshSegmentNow", actions.refreshSegmentNow, "email.write"],
  ["createTask", actions.createTask, "persons.read"],
  ["updateTask", actions.updateTask, "persons.read"],
  ["completeTask", actions.completeTask, "persons.read"],
  ["cancelTask", actions.cancelTask, "persons.read"],
  ["reopenTask", actions.reopenTask, "persons.read"],
  ["saveCompany", actions.saveCompany, "crm.b2b"],
  ["linkContact", actions.linkContact, "crm.b2b"],
  ["updateContact", actions.updateContact, "crm.b2b"],
  ["endContact", actions.endContact, "crm.b2b"],
  ["addNote", actions.addNote, "persons.write"],
  ["logInteraction", actions.logInteraction, "persons.write"],
  ["loadTimeline", timeline.loadTimeline, "persons.read"],
];

const CUSTOMER_ACTIONS: Array<[string, Call]> = [
  ["updateMyProfile", actions.updateMyProfile],
  ["updateMyPreferences", actions.updateMyPreferences],
];

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  for (const purpose of ["newsletter", "events", "member_comms", "b2b"] as const) {
    await h.db.insert(consentWordings).values({ purpose, version: 1, text: { en: purpose, "nl-BE": purpose, "fr-BE": purpose }, publishedAt: new Date("2026-01-01T00:00:00Z") }).onConflictDoNothing();
  }
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

/** Signs in a staff user whose role holds exactly `permissions`. */
async function signInWith(permissions: readonly string[]) {
  const user = await makeUser(h.db, { roleKey: "marketing" });
  await h.db.update(roles).set({ permissions: [...permissions] }).where(eq(roles.key, "marketing"));
  const { token } = await auth.createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "marketing", now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  return user;
}

async function signInCustomer() {
  const email = `cust-${randomUUID().slice(0, 8)}@example.com`;
  const p = await makePerson(h.db, { email, emailHash: emailHash(email), firstName: "Own", lastName: "Customer" });
  const user = await makeUser(h.db, { audience: "customer", email, personId: p.id, roleKey: null });
  const { token } = await auth.createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  return p;
}

describe("crm permissions (spec 7)", () => {
  it("lists only declared permissions", () => {
    const declared = new Set<string>(PERMISSIONS as readonly string[]);
    for (const [, , permission] of STAFF_ACTIONS) expect(declared.has(permission), permission).toBe(true);
  });

  it.each(STAFF_ACTIONS)("%s refuses a staff user without its permission", async (_name, call, permission) => {
    const others = (PERMISSIONS as readonly string[]).filter((p) => p !== permission);
    await signInWith(others);
    const result = await call({});
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it.each(STAFF_ACTIONS)("%s refuses a customer session", async (_name, call) => {
    await signInCustomer();
    const result = await call({});
    expect(result.ok).toBe(false);
    expect(["unauthorized", "forbidden"]).toContain(result.error?.code);
  });

  it.each(CUSTOMER_ACTIONS)("%s refuses a staff session", async (_name, call) => {
    await signInWith(PERMISSIONS as readonly string[]);
    const result = await call({});
    expect(result).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("updateMyProfile changes only the signed-in customer's person, whatever id the input names", async () => {
    const other = await makePerson(h.db, { firstName: "Other", lastName: "Person" });
    const me = await signInCustomer();
    const result = await actions.updateMyProfile({ personId: other.id, version: me.version, firstName: "Changed", lastName: "Customer", locale: "nl-BE" });
    expect(result.ok).toBe(true);
    const [mine] = await h.db.select().from(persons).where(eq(persons.id, me.id));
    const [theirs] = await h.db.select().from(persons).where(eq(persons.id, other.id));
    expect(mine!.firstName).toBe("Changed");
    expect(theirs).toMatchObject({ firstName: "Other", version: other.version });
  });

  it("updateMyPreferences records consent only for the signed-in customer", async () => {
    const other = await makePerson(h.db);
    const me = await signInCustomer();
    const result = await actions.updateMyPreferences({ personId: other.id, newsletter: true, events: false, member_comms: false, b2b: false });
    expect(result.ok).toBe(true);
    expect(await h.db.select().from(consentRecords).where(eq(consentRecords.personId, other.id))).toEqual([]);
    expect((await h.db.select().from(consentRecords).where(eq(consentRecords.personId, me.id))).map((r) => [r.purpose, r.status])).toEqual([["newsletter", "granted"]]);
  });

  it("addNote with isSensitive needs persons.sensitive_read on top of persons.write", async () => {
    await signInWith(["persons.read", "persons.write"]);
    const p = await makePerson(h.db);
    expect(await actions.addNote({ personId: p.id, body: "x", isSensitive: true })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await actions.addNote({ personId: p.id, body: "plain note", isSensitive: false })).toMatchObject({ ok: true });
  });
});

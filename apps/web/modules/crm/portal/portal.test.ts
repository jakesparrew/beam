/**
 * crm-P3 customer portal (crm spec 4.1 customer actions, 5.2): a signed-in customer changes only
 * their own person, never the email; preferences use method `portal` and the current wording.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, consentWordings, persons, suppressions } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p3-portal-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.43" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/automation/api", () => ({ requestSuppressionExit: () => Promise.resolve({ jobId: null }) }));

const actions = await import("./actions");
const queries = await import("./queries");
const consent = await import("../consent/api");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
let me: { id: string; email: string };

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  for (const purpose of ["newsletter", "events", "member_comms", "b2b"] as const) {
    await h.db.insert(consentWordings).values({ purpose, version: 1, text: { en: `${purpose} text`, "nl-BE": purpose, "fr-BE": purpose }, publishedAt: new Date("2026-01-01T00:00:00Z") });
  }
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  const email = `c-${randomUUID().slice(0, 8)}@example.com`;
  const p = await makePerson(h.db, { email, emailHash: emailHash(email), firstName: "Mira", lastName: "Janssens" });
  const user = await makeUser(h.db, { audience: "customer", email, personId: p.id, roleKey: null });
  const { token } = await auth.createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  me = { id: p.id, email };
});

const rowOf = async (id: string) => (await h.db.select().from(persons).where(eq(persons.id, id)))[0]!;

describe("portal profile", () => {
  it("a customer can only change their own record", async () => {
    const other = await makePerson(h.db, { firstName: "Other", lastName: "Person" });
    const profile = (await queries.getMyProfile(h.db, me.id))!;
    const out = await actions.updateMyProfile({ version: profile.version, firstName: "Mirabel", lastName: "Janssens", locale: "fr-BE", phone: "0470 12 34 56", personId: other.id });
    expect(out).toEqual({ ok: true, data: { version: profile.version + 1 } });
    expect(await rowOf(me.id)).toMatchObject({ firstName: "Mirabel", locale: "fr-BE", phoneE164: "+32470123456" });
    expect(await rowOf(other.id)).toMatchObject({ firstName: "Other", lastName: "Person", version: other.version });
    const kinds = (await h.db.select().from(activityEvents).where(eq(activityEvents.personId, me.id))).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["person.updated", "person.locale_changed"]));
    expect(await actions.updateMyProfile({ version: profile.version, firstName: "Late", lastName: "Write", locale: "en" })).toMatchObject({ ok: false, error: { code: "conflict", message: "stale_version" } });
  });

  it("the email is not editable in the portal", async () => {
    const profile = (await queries.getMyProfile(h.db, me.id))!;
    expect(profile).toMatchObject({ email: me.email, firstName: "Mira", customerNumber: expect.stringMatching(/^C-\d{6,}$/) });
    const out = await actions.updateMyProfile({ version: profile.version, firstName: "Mira", lastName: "Janssens", locale: "nl-BE", email: "changed@example.com" });
    expect(out.ok).toBe(true);
    expect((await rowOf(me.id)).email).toBe(me.email);
  });

  it("a staff or anonymous visitor cannot use the customer actions", async () => {
    jar.clear();
    expect(await actions.updateMyProfile({ version: 1, firstName: "A", lastName: "B", locale: "en" })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await actions.updateMyPreferences({ newsletter: true, events: false, member_comms: false, b2b: false })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });
});

describe("portal preferences", () => {
  it("switches grant with method portal and the current wording; unsubscribe all suppresses the address", async () => {
    const out = await actions.updateMyPreferences({ newsletter: true, events: true, member_comms: false, b2b: false });
    expect(out).toMatchObject({ ok: true, data: { changed: ["newsletter", "events"] } });
    const current = await consent.getCurrentConsents(h.db, me.id);
    expect(current.newsletter).toMatchObject({ status: "granted", method: "portal", source: "portal", wordingVersion: "newsletter@1" });
    const prefs = (await queries.getMyPreferences(h.db, me.id))!;
    expect(prefs.purposes).toEqual({ newsletter: true, events: true, member_comms: false, b2b: false });
    expect(prefs.wordings.newsletter).toMatchObject({ en: "newsletter text" });

    const all = await actions.updateMyPreferences({ newsletter: true, events: true, member_comms: false, b2b: false, unsubscribeAll: true });
    expect(all).toMatchObject({ ok: true, data: { changed: ["newsletter", "events"] } });
    const supp = await h.db.select().from(suppressions).where(and(eq(suppressions.emailHash, emailHash(me.email)), eq(suppressions.scope, "all")));
    expect(supp).toHaveLength(1);
    expect((await queries.getMyPreferences(h.db, me.id))!).toMatchObject({ suppressedAll: true, purposes: { newsletter: false, events: false } });
  });

  it("a minor's grant is not recorded and reported as skipped_minor", async () => {
    await h.db.update(persons).set({ birthOn: "2017-01-01" }).where(eq(persons.id, me.id));
    const out = await actions.updateMyPreferences({ newsletter: true, events: false, member_comms: false, b2b: false });
    expect(out).toMatchObject({ ok: true, data: { changed: [], skipped: { newsletter: "skipped_minor" } } });
  });
});

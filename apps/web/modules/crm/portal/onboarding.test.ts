/**
 * Portal onboarding (owner requirements item 10): every answer goes through the normal crm paths
 * (timeline events, consent records, company contacts), a skip changes nothing but the progress,
 * nothing is consented that was not ticked, and a VAT number makes the client a corporate client.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, companies, companyContacts, consentWordings, persons } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-onboarding-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.44" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/automation/api", () => ({ requestSuppressionExit: () => Promise.resolve({ jobId: null }) }));

const actions = await import("./actions");
const queries = await import("./queries");
const consent = await import("../consent/api");
const { listPersons } = await import("../persons/queries");
const auth = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
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

async function signIn(): Promise<{ id: string; email: string }> {
  jar.clear();
  const email = `o-${randomUUID().slice(0, 8)}@example.com`;
  const p = await makePerson(h.db, { email, emailHash: emailHash(email), firstName: "Lotte", lastName: "Peeters" });
  const user = await makeUser(h.db, { audience: "customer", email, personId: p.id, roleKey: null });
  const { token } = await auth.createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  return { id: p.id, email };
}

beforeEach(async () => {
  me = await signIn();
});

const rowOf = async (id: string) => (await h.db.select().from(persons).where(eq(persons.id, id)))[0]!;
const kinds = async (id: string) => (await h.db.select().from(activityEvents).where(eq(activityEvents.personId, id))).map((e) => e.kind);

describe("onboarding progress", () => {
  it("is unseen until the flow opens, then counts answered steps; dismissing ends the card", async () => {
    expect(await queries.getMyOnboardingProgress(h.db, me.id)).toMatchObject({ unseen: true, answered: 0, total: 4, done: false, next: "emergency" });
    expect(await actions.markMyOnboarding({ event: "seen" })).toEqual({ ok: true, data: {} });
    expect(await queries.getMyOnboardingProgress(h.db, me.id)).toMatchObject({ unseen: false, done: false });
    await actions.saveMyOnboardingStep({ step: "emergency" });
    expect(await queries.getMyOnboardingProgress(h.db, me.id)).toMatchObject({ answered: 0, next: "communication", done: false });
    await actions.markMyOnboarding({ event: "dismissed" });
    expect(await queries.getMyOnboardingProgress(h.db, me.id)).toMatchObject({ done: true, next: "communication" });
  });

  it("a skip changes nothing but the progress", async () => {
    const before = await rowOf(me.id);
    expect(await actions.saveMyOnboardingStep({ step: "about" })).toMatchObject({ ok: true });
    const after = await rowOf(me.id);
    expect(after.version).toBe(before.version);
    expect(after.onboarding).toMatchObject({ steps: { about: "skipped" }, seen_at: expect.any(String) });
    expect(await kinds(me.id)).not.toContain("person.updated");
  });

  it("an anonymous visitor cannot use the onboarding actions", async () => {
    jar.clear();
    expect(await actions.saveMyOnboardingStep({ step: "emergency" })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await actions.markMyOnboarding({ event: "seen" })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });
});

describe("onboarding answers", () => {
  it("the emergency contact lands on the person, where bookings read it, with a timeline event", async () => {
    const out = await actions.saveMyOnboardingStep({ step: "emergency", answer: { name: "Jan Peeters", phone: "0470 11 22 33", relation: "partner" } });
    expect(out.ok).toBe(true);
    expect((await rowOf(me.id)).emergencyContact).toEqual({ name: "Jan Peeters", phone: "+32470112233", relation: "partner" });
    expect(await kinds(me.id)).toContain("person.updated");
    expect((await queries.getMyOnboardingProgress(h.db, me.id))!.answered).toBe(1);
  });

  it("records consent only for the ticked purposes and stores the channel", async () => {
    const out = await actions.saveMyOnboardingStep({ step: "communication", answer: { newsletter: true, events: false, member_comms: false, b2b: false, preferredChannel: "whatsapp" } });
    expect(out.ok).toBe(true);
    const current = await consent.getCurrentConsents(h.db, me.id);
    expect(current.newsletter).toMatchObject({ status: "granted", method: "portal", source: "onboarding" });
    expect(current.events ?? null).toBeNull();
    expect(current.b2b ?? null).toBeNull();
    expect((await rowOf(me.id)).preferredChannel).toBe("whatsapp");
  });

  it("date of birth and language go through the profile path", async () => {
    await actions.saveMyOnboardingStep({ step: "about", answer: { birthOn: "1988-04-12", locale: "fr-BE" } });
    expect(await rowOf(me.id)).toMatchObject({ birthOn: "1988-04-12", locale: "fr-BE" });
    expect(await kinds(me.id)).toEqual(expect.arrayContaining(["person.updated", "person.locale_changed"]));
  });

  it("a VAT number makes a corporate client; an existing company is linked, never edited", async () => {
    expect(await actions.saveMyOnboardingStep({ step: "company", answer: { vatNumber: "BE12", companyName: "Nope" } })).toMatchObject({
      ok: false,
      error: { code: "validation", fields: { vatNumber: "vat_invalid" } },
    });
    expect((await queries.getMyOnboardingProgress(h.db, me.id))!.next).toBe("emergency");

    const vat = `BE0${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    const out = await actions.saveMyOnboardingStep({
      step: "company",
      answer: { vatNumber: `${vat.slice(0, 6)}.${vat.slice(6)}`, companyName: "Lotte Wellness BV", address: { street: "Kerkstraat", number: "1", postal_code: "9000", city: "Gent", country: "BE" } },
    });
    expect(out.ok).toBe(true);
    const [company] = await h.db.select().from(companies).where(eq(companies.vatNumber, vat));
    expect(company).toMatchObject({ name: "Lotte Wellness BV", status: "customer", address: { city: "Gent" } });
    expect(await kinds(me.id)).toContain("company.contact_linked");
    expect((await queries.getMyOnboarding(h.db, me.id))!.company).toMatchObject({ name: "Lotte Wellness BV", vatNumber: vat });

    const corporate = await listPersons(h.db, { q: me.email, isCorporate: true, page: 1, pageSize: 10, sort: "created_at" });
    expect(corporate.rows.map((r) => [r.id, r.isCorporate])).toEqual([[me.id, true]]);
    expect((await listPersons(h.db, { q: me.email, isCorporate: false, page: 1, pageSize: 10, sort: "created_at" })).rows).toEqual([]);

    const colleague = await signIn();
    await actions.saveMyOnboardingStep({ step: "company", answer: { vatNumber: vat, companyName: "Renamed by a client" } });
    const [same] = await h.db.select().from(companies).where(eq(companies.vatNumber, vat));
    expect(same).toMatchObject({ id: company!.id, name: "Lotte Wellness BV" });
    const contacts = await h.db.select().from(companyContacts).where(eq(companyContacts.companyId, company!.id));
    expect(contacts.map((c) => c.personId).sort()).toEqual([me.id, colleague.id].sort());
  });
});

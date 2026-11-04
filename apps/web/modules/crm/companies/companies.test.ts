/**
 * crm-P6 companies (rule 3.45, crm spec 2.7): `upsertCompany` matches on VAT then name and is
 * idempotent, `addCompanyContact` twice creates one row, a partner company lists the persons it
 * referred, VAT normalisation and uniqueness, one person as customer and contact, the partial
 * unique primary contact, and ending a contact keeps its history.
 */
import { randomBytes, randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, auditLog, companies, companyContacts, persons } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p6-companies-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.62" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const api = await import("./api");
const actions = await import("./actions");
const { getCompany: getCompanyDetail, listCompanies } = await import("./queries");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let b2b: ReturnType<typeof staffActor>;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  const user = await makeUser(h.db, { roleKey: "sales" });
  b2b = staffActor({ userId: user.id, roleKey: "sales", permissions: ["persons.read", "persons.write", "crm.b2b"] });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

const tx = () => h.db as unknown as Parameters<typeof api.upsertCompany>[0];
const ctx = () => makeCtx(h.db, { actor: b2b });
/** A random Belgian VAT number, typed the messy way and normalised. */
function vat(): { typed: string; normalised: string } {
  const digits = String(randomInt(0, 1_000_000_000)).padStart(9, "0");
  return { typed: `be 0${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`, normalised: `BE0${digits}` };
}
const companyRow = async (id: string) => (await h.db.select().from(companies).where(eq(companies.id, id)))[0]!;
const eventKinds = async (companyId: string) =>
  (await h.db.select({ kind: activityEvents.kind }).from(activityEvents).where(eq(activityEvents.companyId, companyId)).orderBy(activityEvents.id)).map((e) => e.kind);

async function newCompany(extra: Partial<typeof companies.$inferInsert> = {}) {
  const [row] = await h.db
    .insert(companies)
    .values({ name: `Company ${randomInt(1e9)}`, ...extra })
    .returning();
  return row!;
}

describe("upsertCompany (ops imports)", () => {
  it("matches on the normalised VAT number first and is idempotent", async () => {
    const v = vat();
    const created = await api.upsertCompany(tx(), ctx(), { name: "Acme Wellness", vatNumber: v.typed, industry: "wellness" });
    expect(created.outcome).toBe("created");
    expect(await companyRow(created.companyId)).toMatchObject({ vatNumber: v.normalised, industry: "wellness", status: "target" });

    expect(await api.upsertCompany(tx(), ctx(), { name: "Acme Wellness", vatNumber: v.normalised, industry: "wellness" })).toEqual({ companyId: created.companyId, outcome: "unchanged" });
    expect(await api.upsertCompany(tx(), ctx(), { name: "Acme Wellness BV", vatNumber: v.normalised.toLowerCase(), size: "10_49" })).toEqual({
      companyId: created.companyId,
      outcome: "updated",
    });
    expect(await companyRow(created.companyId)).toMatchObject({ name: "Acme Wellness BV", size: "10_49", industry: "wellness" });
    expect(await api.upsertCompany(tx(), ctx(), { name: "Acme Wellness BV", vatNumber: v.normalised, size: "10_49" })).toMatchObject({ outcome: "unchanged" });
    expect(await eventKinds(created.companyId)).toEqual(["company.created", "company.updated"]);
  });

  it("falls back to the lower-cased name, and a name with another VAT number is another company", async () => {
    const name = `Nordic Spa ${randomInt(1e9)}`;
    const first = await api.upsertCompany(tx(), ctx(), { name });
    expect(first.outcome).toBe("created");
    expect(await api.upsertCompany(tx(), ctx(), { name: name.toUpperCase(), website: "https://spa.example.com" })).toEqual({ companyId: first.companyId, outcome: "updated" });
    expect(await companyRow(first.companyId)).toMatchObject({ name, website: "https://spa.example.com" });
    expect(await api.upsertCompany(tx(), ctx(), { name: name.toLowerCase() })).toEqual({ companyId: first.companyId, outcome: "unchanged" });

    const v = vat();
    expect(await api.upsertCompany(tx(), ctx(), { name, vatNumber: v.typed })).toEqual({ companyId: first.companyId, outcome: "updated" });
    const other = await api.upsertCompany(tx(), ctx(), { name, vatNumber: vat().typed });
    expect(other.outcome).toBe("created");
    expect(other.companyId).not.toBe(first.companyId);
  });

  it("refuses a value that is not a VAT number", async () => {
    await expect(api.upsertCompany(tx(), ctx(), { name: "Broken", vatNumber: "hello world" })).rejects.toMatchObject({ code: "validation", message: "vat_invalid" });
  });
});

describe("rule 3.45: VAT normalisation and uniqueness", () => {
  it("stores the normalised VAT number and refuses a second company with it however it is typed", async () => {
    const v = vat();
    const { companyId } = await api.saveStaffCompany(ctx(), { name: "Studio One", vatNumber: v.typed, status: "prospect", isPartner: false });
    expect((await companyRow(companyId)).vatNumber).toBe(v.normalised);
    await expect(api.saveStaffCompany(ctx(), { name: "Studio Two", vatNumber: v.normalised.toLowerCase(), status: "target", isPartner: false })).rejects.toMatchObject({
      code: "conflict",
      message: "vat_taken",
    });
    await expect(api.saveStaffCompany(ctx(), { name: "Studio Three", vatNumber: "12", status: "target", isPartner: false })).rejects.toMatchObject({ code: "validation" });

    // Saving the company itself with its own number is no conflict; another company taking it is.
    await api.saveStaffCompany(ctx(), { id: companyId, name: "Studio One BV", vatNumber: v.typed, status: "customer", isPartner: true, partnerCommissionPct: 12.5 });
    expect(await companyRow(companyId)).toMatchObject({ name: "Studio One BV", status: "customer", isPartner: true, partnerCommissionPct: "12.50" });
    const other = await api.saveStaffCompany(ctx(), { name: "Studio Four", status: "target", isPartner: false });
    await expect(api.saveStaffCompany(ctx(), { id: other.companyId, name: "Studio Four", vatNumber: v.typed, status: "target", isPartner: false })).rejects.toMatchObject({
      code: "conflict",
    });
    // The database keeps the rule too.
    await expect(h.db.insert(companies).values({ name: "Raw", vatNumber: v.normalised })).rejects.toThrow();

    expect(await eventKinds(companyId)).toEqual(["company.created", "company.updated"]);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "company.save"), eq(auditLog.entityId, companyId)));
    expect(audits).toHaveLength(2);
    expect(audits.find((a) => a.oldValue)!.oldValue).toMatchObject({ name: "Studio One" });
  });

  it("answers a taken VAT number through the action with `conflict` `vat_taken`", async () => {
    const owner = await makeUser(h.db, { roleKey: "owner" });
    const { token } = await auth.createAuthSession(h.db, { userId: owner.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
    jar.set(auth.SESSION_COOKIE, token);
    const v = vat();
    const first = await actions.saveCompany({ name: "Action Co", vatNumber: v.typed, status: "target", isPartner: false });
    expect(first.ok).toBe(true);
    expect(await actions.saveCompany({ name: "Action Co 2", vatNumber: v.normalised, status: "target", isPartner: false })).toMatchObject({
      ok: false,
      error: { code: "conflict", message: "vat_taken" },
    });
    const rows = await listCompanies(h.db, { q: v.typed });
    expect(rows.map((r) => r.name)).toEqual(["Action Co"]);
  });
});

describe("contacts", () => {
  it("addCompanyContact twice creates one row", async () => {
    const company = await newCompany();
    const person = await makePerson(h.db);
    const first = await api.addCompanyContact(tx(), ctx(), { companyId: company.id, personId: person.id, position: "CEO", decisionRole: "decision_maker" });
    const second = await api.addCompanyContact(tx(), ctx(), { companyId: company.id, personId: person.id, position: "Founder" });
    expect(first.created).toBe(true);
    expect(second).toEqual({ contactId: first.contactId, created: false });
    const rows = await h.db.select().from(companyContacts).where(eq(companyContacts.companyId, company.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ position: "CEO", decisionRole: "decision_maker" });
    expect(await eventKinds(company.id)).toEqual(["company.contact_linked"]);
  });

  it("one person is a B2C customer and a B2B contact: linking leaves the person untouched", async () => {
    const company = await newCompany({ name: "Contact Corp" });
    const person = await makePerson(h.db, { statusOverride: "customer", statusOverrideReason: "VIP" });
    const [before] = await h.db.select().from(persons).where(eq(persons.id, person.id));
    await api.linkStaffContact(ctx(), { companyId: company.id, personId: person.id, position: "HR lead", decisionRole: "influencer", isPrimary: true });
    const [after] = await h.db.select().from(persons).where(eq(persons.id, person.id));
    expect(after).toEqual(before);
    expect(await api.listPersonCompanies(h.db, person.id)).toEqual([{ companyId: company.id, name: "Contact Corp", position: "HR lead", decisionRole: "influencer" }]);
    const personEvents = await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, person.id), eq(activityEvents.kind, "company.contact_linked")));
    expect(personEvents).toHaveLength(1);
    expect(personEvents[0]!.companyId).toBe(company.id);
  });

  it("keeps one current primary contact per company", async () => {
    const company = await newCompany();
    const [a, b] = [await makePerson(h.db), await makePerson(h.db)];
    const first = await api.linkStaffContact(ctx(), { companyId: company.id, personId: a.id, isPrimary: true });
    await expect(h.db.insert(companyContacts).values({ companyId: company.id, personId: b.id, isPrimary: true })).rejects.toThrow();
    const second = await api.linkStaffContact(ctx(), { companyId: company.id, personId: b.id, isPrimary: true });
    const rows = await h.db.select().from(companyContacts).where(eq(companyContacts.companyId, company.id));
    expect(rows.find((r) => r.id === first.contactId)!.isPrimary).toBe(false);
    expect(rows.find((r) => r.id === second.contactId)!.isPrimary).toBe(true);
    await api.updateStaffContact(ctx(), { contactId: first.contactId, isPrimary: true });
    const again = await h.db.select().from(companyContacts).where(and(eq(companyContacts.companyId, company.id), eq(companyContacts.isPrimary, true)));
    expect(again.map((r) => r.id)).toEqual([first.contactId]);
  });

  it("ending a contact keeps the row as history; relinking reopens the same row", async () => {
    const company = await newCompany();
    const person = await makePerson(h.db);
    const { contactId } = await api.linkStaffContact(ctx(), { companyId: company.id, personId: person.id, position: "Office manager", isPrimary: true });
    await expect(api.linkStaffContact(ctx(), { companyId: company.id, personId: person.id, isPrimary: false })).rejects.toMatchObject({ code: "conflict", message: "contact_exists" });

    await api.updateStaffContact(ctx(), { contactId, endedOn: "2026-06-30" });
    const [row] = await h.db.select().from(companyContacts).where(eq(companyContacts.id, contactId));
    expect(row).toMatchObject({ endedOn: "2026-06-30", position: "Office manager" });
    await expect(api.updateStaffContact(ctx(), { contactId, endedOn: "2026-07-01" })).rejects.toMatchObject({ code: "conflict", message: "contact_ended" });
    expect(await api.listPersonCompanies(h.db, person.id)).toEqual([]);

    const detail = await getCompanyDetail(h.db, company.id);
    expect(detail).toMatchObject({ contacts: 0 });
    expect(detail!.contactList).toEqual([expect.objectContaining({ id: contactId, endedOn: "2026-06-30" })]);
    expect(await eventKinds(company.id)).toEqual(["company.contact_linked", "company.contact_unlinked"]);
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "company.contact_update"), eq(auditLog.entityId, contactId)))).toHaveLength(1);

    const relinked = await api.linkStaffContact(ctx(), { companyId: company.id, personId: person.id, position: "Director", isPrimary: false });
    expect(relinked.contactId).toBe(contactId);
    expect(await h.db.select().from(companyContacts).where(eq(companyContacts.companyId, company.id))).toEqual([expect.objectContaining({ endedOn: null, position: "Director" })]);
  });

  it("links a new person as contact, needing persons.write and refusing a taken email", async () => {
    const company = await newCompany();
    const email = `contact-${randomInt(1e9)}@example.com`;
    const { personId } = await api.linkStaffContact(ctx(), {
      companyId: company.id,
      newPerson: { email, firstName: "Nora", lastName: "Contact", locale: "fr-BE", acquisition: { source: "manual" } },
      decisionRole: "gatekeeper",
      isPrimary: false,
    });
    expect((await h.db.select().from(persons).where(eq(persons.id, personId)))[0]).toMatchObject({ email, locale: "fr-BE" });
    await expect(
      api.linkStaffContact(ctx(), { companyId: company.id, newPerson: { email: email.toUpperCase(), locale: "nl-BE", acquisition: { source: "manual" } }, isPrimary: false }),
    ).rejects.toMatchObject({ code: "conflict", message: "email_taken" });
    const readOnly = staffActor({ userId: b2b.userId, permissions: ["crm.b2b"] });
    await expect(
      api.linkStaffContact(makeCtx(h.db, { actor: readOnly }), { companyId: company.id, newPerson: { lastName: "Nobody", locale: "en", acquisition: { source: "manual" } }, isPrimary: false }),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });
});

describe("partner companies", () => {
  it("lists the persons a partner company referred", async () => {
    const partner = await newCompany({ name: "Partner Gym", isPartner: true, partnerCommissionPct: "15.00" });
    const a = await makePerson(h.db, { firstName: "Ann", lastName: "Referred", partnerCompanyId: partner.id });
    const b = await makePerson(h.db, { firstName: "Bart", lastName: "Referred", partnerCompanyId: partner.id });
    await makePerson(h.db, { firstName: "Gone", lastName: "Erased", partnerCompanyId: partner.id, erasedAt: new Date() });
    await makePerson(h.db, { firstName: "Merged", lastName: "Loser", partnerCompanyId: partner.id, mergedIntoPersonId: a.id });

    const detail = await getCompanyDetail(h.db, partner.id);
    expect(detail).toMatchObject({ isPartner: true, partnerCommissionPct: 15, referredCount: 2 });
    expect(detail!.referredPersons).toEqual([
      { id: a.id, name: "Ann Referred" },
      { id: b.id, name: "Bart Referred" },
    ]);
    expect(await api.listPartnerCompanies(h.db)).toContainEqual({ id: partner.id, name: "Partner Gym", commissionPct: 15 });
    expect(await api.getCompany(h.db, partner.id)).toEqual({ id: partner.id, name: "Partner Gym", vatNumber: null, status: "target", isPartner: true, commissionPct: 15 });
    expect(await api.getCompany(h.db, "00000000-0000-4000-8000-000000000000")).toBeNull();
    expect((await listCompanies(h.db, { isPartner: true })).map((c) => c.id)).toContain(partner.id);
  });
});

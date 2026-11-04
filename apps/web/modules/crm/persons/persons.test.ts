/**
 * crm-P2 identity (crm rules 3.1 to 3.12, 3.52, 3.55) on a PGlite database: the person actions
 * through `action()` with a signed-in owner, the cross-module api with test contexts, and the
 * commercial status against credits' real `v_person_status`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeSession, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { makeMembership } from "@beam/db/testing/credits-factories";
import type { DbHandle, DbOrTx } from "@beam/db";
import { activityEvents, auditLog, jobs, orderLines, persons, users, vStatusOverrideConflicts } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p2-persons-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.30" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const referral = vi.hoisted(() => ({ codes: new Map<string, { codeId: string; referrerPersonId: string | null; partnerCompanyId: string | null }>() }));
vi.mock("@/modules/credits/api", () => ({
  resolveReferralCode: (_db: unknown, code: string) => Promise.resolve(referral.codes.get(code) ?? null),
}));

const actions = await import("./actions");
const api = await import("./api");
const auth = await import("@/lib/auth");
const { and, createCtx, eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, staffActor } = await import("@/lib/testing");

let h: DbHandle;
let owner: { id: string };

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
  owner = await makeUser(h.db, { roleKey: "owner" });
  const { token } = await auth.createAuthSession(h.db, { userId: owner.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
});

const sysCtx = () => makeCtx(h.db);
const staffCtx = () => makeCtx(h.db, staffActor({ userId: owner.id, roleKey: "owner", permissions: ["*"] }));
const tx = () => h.db as unknown as Parameters<typeof api.findOrCreatePersonByEmail>[0];
const uniq = () => randomUUID().slice(0, 8);
const row = async (id: string) => (await h.db.select().from(persons).where(eq(persons.id, id)))[0]!;
const eventsOf = async (personId: string, kind?: string) =>
  h.db
    .select()
    .from(activityEvents)
    .where(kind ? and(eq(activityEvents.personId, personId), eq(activityEvents.kind, kind)) : eq(activityEvents.personId, personId));

async function paidOrder(db: DbOrTx, personId: string, kind: "item" | "voucher" | "package" | "session") {
  const order = await makeOrder(db, { personId, channel: "portal", status: "paid", subtotalCents: 5000, vatCents: 0, totalCents: 5000 });
  const product = await makeProduct(db, { kind });
  await db.insert(orderLines).values({
    orderId: order.id,
    lineNo: 1,
    productId: product.id,
    sku: product.sku,
    productKind: kind,
    ...(kind === "session" ? { sessionId: (await makeSession(db)).id } : {}),
    description: { en: kind },
    quantity: 1,
    unitAmountCents: 5000,
    lineTotalCents: 5000,
    vatRatePct: "21.00",
    vatCents: 0,
    pricingTrace: {},
  });
  return order;
}

describe("identity (rules 3.1 to 3.7)", () => {
  it("3.1 stores the email trimmed and lower-cased and refuses a second active person with it", async () => {
    const email = `Anna.${uniq()}@Example.com`;
    const created = await actions.createPerson({ email: `  ${email} `, firstName: "Anna", lastName: `Peeters ${uniq()}`, locale: "nl-BE", acquisition: { source: "manual" } });
    expect(created.ok).toBe(true);
    const id = (created as { data: { personId: string } }).data.personId;
    expect((await row(id)).email).toBe(email.toLowerCase());
    expect((await row(id)).emailHash).toBe(emailHash(email.toLowerCase()));
    const again = await actions.createPerson({ email, lastName: "Other", locale: "nl-BE", acquisition: { source: "manual" }, confirmDuplicates: true });
    expect(again).toMatchObject({ ok: false, error: { code: "conflict", message: "email_taken" } });
    const empty = await actions.createPerson({ email: " ", locale: "nl-BE", acquisition: { source: "manual" } });
    expect(empty).toMatchObject({ ok: false, error: { code: "validation", message: "need_identity" } });
  });

  it("3.2 concurrent findOrCreatePersonByEmail creates exactly one person, and a merged address resolves to the winner", async () => {
    const email = `race-${uniq()}@example.com`;
    const results = await Promise.all(
      [0, 1, 2].map(() => h.db.transaction((t) => api.findOrCreatePersonByEmail(t, createCtx({ tx: t, actor: { kind: "system", jobId: "" }, durableMode: "immediate" }), { email, locale: "fr-BE", acquisition: { source: "website" } }))),
    );
    expect(new Set(results.map((r) => r.personId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await h.db.select().from(persons).where(eq(persons.email, email))).toHaveLength(1);

    const winner = await makePerson(h.db);
    const loserEmail = `merged-${uniq()}@example.com`;
    await makePerson(h.db, { email: loserEmail, mergedIntoPersonId: winner.id });
    expect(await api.findOrCreatePersonByEmail(tx(), sysCtx(), { email: loserEmail, locale: "nl-BE" })).toEqual({ personId: winner.id, created: false });
  });

  it("3.3 an existing person only gets empty fields filled; locale and acquisition never change", async () => {
    const p = await makePerson(h.db, { firstName: "Kept", lastName: null, phone: null, locale: "en", acquisition: { source: "webinar", captured_at: "2026-01-01T00:00:00.000Z" } });
    const out = await api.findOrCreatePersonByEmail(tx(), sysCtx(), { email: p.email!.toUpperCase(), firstName: "Changed", lastName: "Filled", phone: "0470 12 34 56", locale: "nl-BE", acquisition: { source: "paid_meta" } });
    expect(out).toEqual({ personId: p.id, created: false });
    const after = await row(p.id);
    expect(after).toMatchObject({ firstName: "Kept", lastName: "Filled", phone: "0470 12 34 56", phoneE164: "+32470123456", locale: "en" });
    expect(after.acquisition).toMatchObject({ source: "webinar" });
  });

  it("3.4 person.created carries acquisition_source; guest needs a referrer; referral codes fill the referrer or are dropped", async () => {
    const { personId } = await api.findOrCreatePersonByEmail(tx(), sysCtx(), { email: `src-${uniq()}@example.com`, locale: "nl-BE", acquisition: { source: "paid_meta", campaign: "spring" } });
    const [created] = await eventsOf(personId, "person.created");
    expect(created!.data).toEqual({ acquisition_source: "paid_meta", acquisition_campaign: "spring", source: "system" });
    expect((await row(personId)).acquisition).toMatchObject({ source: "paid_meta", campaign: "spring", captured_at: expect.any(String) });

    await expect(api.createPersonWithoutEmail(tx(), sysCtx(), { firstName: "Guest", locale: "nl-BE", acquisition: { source: "guest" } })).rejects.toMatchObject({ code: "validation" });
    const owner2 = await makePerson(h.db);
    const guest = await api.createPersonWithoutEmail(tx(), sysCtx(), { firstName: "Guest", locale: "nl-BE", acquisition: { source: "guest", referrer_person_id: owner2.id } });
    expect((await row(guest.personId)).acquisition).toMatchObject({ source: "guest", referrer_person_id: owner2.id });

    const referrer = await makePerson(h.db);
    referral.codes.set("FRIEND10", { codeId: randomUUID(), referrerPersonId: referrer.id, partnerCompanyId: null });
    const known = await api.findOrCreatePersonByEmail(tx(), sysCtx(), { email: `ref-${uniq()}@example.com`, locale: "nl-BE", acquisition: { source: "referral", referral_code: "friend10" } });
    expect((await row(known.personId)).acquisition).toMatchObject({ referral_code: "FRIEND10", referrer_person_id: referrer.id });
    const unknown = await api.findOrCreatePersonByEmail(tx(), sysCtx(), { email: `ref-${uniq()}@example.com`, locale: "nl-BE", acquisition: { source: "referral", referral_code: "NOPE" } });
    const stored = (await row(unknown.personId)).acquisition;
    expect(stored).toMatchObject({ source: "referral" });
    expect(stored).not.toHaveProperty("referral_code");
    expect(stored).not.toHaveProperty("referrer_person_id");
  });

  it("3.4 acquisition is written once: fillAcquisition refuses a set source, fills a missing one, and is audited", async () => {
    const set = await makePerson(h.db);
    expect(await actions.fillAcquisition({ personId: set.id, acquisition: { source: "event" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const missing = await makePerson(h.db, { acquisition: {} });
    expect(await actions.fillAcquisition({ personId: missing.id, acquisition: { source: "event", campaign: "open day" } })).toEqual({ ok: true, data: {} });
    expect((await row(missing.id)).acquisition).toMatchObject({ source: "event", campaign: "open day" });
    expect(await eventsOf(missing.id, "person.acquisition_filled")).toHaveLength(1);
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "person.acquisition"), eq(auditLog.entityId, missing.id)))).toHaveLength(1);
    expect(await api.fillAcquisitionIfEmpty(tx(), sysCtx(), missing.id, { source: "website" })).toEqual({ applied: false });
    const other = await makePerson(h.db, { acquisition: {} });
    expect(await api.fillAcquisitionIfEmpty(tx(), sysCtx(), other.id, { source: "website", form_slug: "intake" })).toEqual({ applied: true });
  });

  it("3.5 a locale change by staff writes person.locale_changed; 3.7 phone_e164 follows the phone", async () => {
    const p = await makePerson(h.db, { locale: "nl-BE" });
    const res = await actions.updatePerson({ personId: p.id, version: p.version, patch: { locale: "fr-BE", phone: "0032 470 11 22 33" } });
    expect(res).toEqual({ ok: true, data: { version: p.version + 1 } });
    expect((await eventsOf(p.id, "person.locale_changed"))[0]!.data).toEqual({ from: "nl-BE", to: "fr-BE" });
    expect((await eventsOf(p.id, "person.updated"))[0]!.data).toEqual({ fields: ["phone", "locale"] });
    expect(await row(p.id)).toMatchObject({ phoneE164: "+32470112233", locale: "fr-BE" });
    await actions.updatePerson({ personId: p.id, version: p.version + 1, patch: { phone: "call me" } });
    expect(await row(p.id)).toMatchObject({ phone: "call me", phoneE164: null });
  });

  it("3.6 the database assigns a customer number shown as C-000123", async () => {
    const res = await actions.createPerson({ lastName: `Number ${uniq()}`, locale: "en", acquisition: { source: "walk_in" } });
    const id = (res as { data: { personId: string } }).data.personId;
    const summary = await api.getPerson(tx(), id);
    expect(summary!.customerNumber).toMatch(/^C-\d{6,}$/);
    expect(Number(summary!.customerNumber.slice(2))).toBe((await row(id)).customerNumber);
  });

  it("stale version is a conflict and nothing changes", async () => {
    const p = await makePerson(h.db, { firstName: "Old" });
    expect(await actions.updatePerson({ personId: p.id, version: p.version + 5, patch: { firstName: "New" } })).toMatchObject({ ok: false, error: { code: "conflict", message: "stale_version" } });
    expect((await row(p.id)).firstName).toBe("Old");
  });

  it("3.29 create shows candidates scoring 50 or more until staff confirm, and enqueues crm.check_duplicates", async () => {
    const last = `Janssens${uniq()}`;
    const existing = await makePerson(h.db, { firstName: "Lien", lastName: last, birthOn: "1990-04-02" });
    const input = { firstName: "lien", lastName: last, birthOn: "1990-04-02", locale: "nl-BE" as const, acquisition: { source: "manual" as const } };
    const first = await actions.createPerson(input);
    expect(first).toMatchObject({ ok: false, error: { code: "conflict", message: "possible_duplicates" } });
    const candidates = JSON.parse((first as unknown as { error: { fields: { candidates: string } } }).error.fields.candidates) as { personId: string; score: number }[];
    expect(candidates).toEqual([expect.objectContaining({ personId: existing.id, score: 70, reasons: ["name_birth"] })]);
    const confirmed = await actions.createPerson({ ...input, confirmDuplicates: true });
    expect(confirmed.ok).toBe(true);
    const id = (confirmed as { data: { personId: string } }).data.personId;
    expect(await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `dupcheck:${id}:1`))).toHaveLength(1);
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "person.create"), eq(auditLog.entityId, id)))).toHaveLength(1);
  });
});

describe("commercial status (rules 3.8 to 3.12)", () => {
  it("3.8 a merchandise-only paid order leaves a lead, a package order makes a customer, an active membership a member", async () => {
    const p = await makePerson(h.db);
    await paidOrder(h.db, p.id, "item");
    await paidOrder(h.db, p.id, "voucher");
    expect(await api.getPersonStatus(tx(), p.id)).toEqual({ status: "lead", derivedStatus: "lead", override: null, hasActiveMembership: false });
    await paidOrder(h.db, p.id, "package");
    expect((await api.getPersonStatus(tx(), p.id)).status).toBe("customer");
    const m = await makePerson(h.db);
    await makeMembership(h.db, { personId: m.id });
    expect(await api.getPersonStatus(tx(), m.id)).toMatchObject({ status: "member", hasActiveMembership: true });
  });

  it("3.9 an override needs a 3..500 character reason, is audited with old and new value, and records the event", async () => {
    const p = await makePerson(h.db);
    expect(await actions.setStatusOverride({ personId: p.id, status: "customer", reason: "no" })).toMatchObject({ ok: false, error: { code: "validation" } });
    await expect(api.setStatusOverride(tx(), staffCtx(), { personId: p.id, status: "customer", reason: " ab " })).rejects.toMatchObject({ code: "validation" });
    expect(await actions.setStatusOverride({ personId: p.id, status: "customer", reason: "Paid cash at the desk" })).toEqual({ ok: true, data: { status: "customer" } });
    expect(await row(p.id)).toMatchObject({ statusOverride: "customer", statusOverrideReason: "Paid cash at the desk", statusOverrideByUserId: owner.id });
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "person.status_override"), eq(auditLog.entityId, p.id)));
    expect(audit).toMatchObject({ oldValue: { status_override: null }, newValue: { status_override: "customer" } });
    expect((await eventsOf(p.id, "person.status_overridden"))[0]!.data).toEqual({ from: null, to: "customer", reason: "Paid cash at the desk", source: "manual" });
    expect(await actions.setStatusOverride({ personId: p.id, status: null, reason: "Back to calculated" })).toEqual({ ok: true, data: { status: "lead" } });
    expect((await eventsOf(p.id, "person.status_override_cleared"))[0]!.data).toMatchObject({ from: "customer" });
  });

  it("3.10 onlyIfUnset never replaces an override; source automation is on the event; a paid order never clears it", async () => {
    const p = await makePerson(h.db);
    expect(await api.setStatusOverride(tx(), sysCtx(), { personId: p.id, status: "lead", reason: "Automation step", onlyIfUnset: true, source: "automation" })).toEqual({ applied: true });
    expect((await eventsOf(p.id, "person.status_overridden"))[0]!.data).toMatchObject({ source: "automation", to: "lead" });
    expect(await api.setStatusOverride(tx(), sysCtx(), { personId: p.id, status: "member", reason: "Automation step", onlyIfUnset: true, source: "automation" })).toEqual({ applied: false });
    await paidOrder(h.db, p.id, "session");
    expect(await api.getPersonStatus(tx(), p.id)).toEqual({ status: "lead", derivedStatus: "customer", override: "lead", hasActiveMembership: false });
    expect((await row(p.id)).statusOverride).toBe("lead");
  });

  it("R2: a waiting lead who pays becomes customer while an override lead stays", async () => {
    const waiting = await makePerson(h.db);
    const pinned = await makePerson(h.db, { statusOverride: "lead", statusOverrideReason: "Staff decision" });
    expect((await api.getPersonStatus(tx(), waiting.id)).status).toBe("lead");
    await paidOrder(h.db, waiting.id, "session");
    await paidOrder(h.db, pinned.id, "session");
    expect((await api.getPersonStatus(tx(), waiting.id)).status).toBe("customer");
    expect((await api.getPersonStatus(tx(), pinned.id)).status).toBe("lead");
  });

  it("3.11 a differing override is in v_status_override_conflicts and 'Keep' records person.status_override_confirmed", async () => {
    const p = await makePerson(h.db, { statusOverride: "lead", statusOverrideReason: "Staff decision", statusOverrideAt: new Date() });
    await paidOrder(h.db, p.id, "package");
    expect(await h.db.select().from(vStatusOverrideConflicts).where(eq(vStatusOverrideConflicts.personId, p.id))).toHaveLength(1);
    expect(await actions.confirmStatusOverride({ personId: p.id })).toEqual({ ok: true, data: {} });
    expect((await eventsOf(p.id, "person.status_override_confirmed"))[0]!.data).toEqual({ status: "lead", derived_status: "customer" });
    const plain = await makePerson(h.db);
    expect(await actions.confirmStatusOverride({ personId: plain.id })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("3.12 hasActiveMembership comes from the membership, never from an override", async () => {
    const p = await makePerson(h.db, { statusOverride: "member", statusOverrideReason: "VIP" });
    expect(await api.getPersonStatus(tx(), p.id)).toMatchObject({ status: "member", derivedStatus: "lead", hasActiveMembership: false });
  });
});

describe("email change and person fields (rules 3.52, 3.55)", () => {
  it("3.52 an email change moves the portal login; another login on the address is a conflict that rolls back", async () => {
    const customer = await makeUser(h.db, { audience: "customer" });
    const p = await row(customer.personId!);
    const fresh = `moved-${uniq()}@example.com`;
    expect(await actions.updatePerson({ personId: p.id, version: p.version, patch: { email: fresh } })).toEqual({ ok: true, data: { version: p.version + 1 } });
    expect((await h.db.select().from(users).where(eq(users.id, customer.id)))[0]!.email).toBe(fresh);
    expect((await row(p.id)).emailHash).toBe(emailHash(fresh));

    const other = await makeUser(h.db, { roleKey: "sales" });
    const res = await actions.updatePerson({ personId: p.id, version: p.version + 1, patch: { email: other.email, firstName: "Changed" } });
    expect(res).toMatchObject({ ok: false, error: { code: "conflict", message: "email_in_use" } });
    expect(await row(p.id)).toMatchObject({ email: fresh, firstName: p.firstName, version: p.version + 1 });
    expect((await h.db.select().from(users).where(eq(users.id, customer.id)))[0]!.email).toBe(fresh);

    const holder = await makePerson(h.db);
    expect(await actions.updatePerson({ personId: p.id, version: p.version + 1, patch: { email: holder.email } })).toMatchObject({ ok: false, error: { code: "conflict", message: "email_taken" } });
  });

  it("3.55 the emergency contact is never in getPersonPrefill or the timeline", async () => {
    const p = await makePerson(h.db, { address: { postal_code: "9000", city: "Gent", country: "BE" } });
    await api.updatePersonFields(tx(), sysCtx(), p.id, { emergencyContact: { name: "Mia", phone: "0470 99 88 77", relation: "partner" } }, { onlyEmpty: true });
    expect((await row(p.id)).emergencyContact).toEqual({ name: "Mia", phone: "+32470998877", relation: "partner" });
    const prefill = await api.getPersonPrefill(tx(), p.id);
    expect(prefill).toEqual({ firstName: p.firstName, lastName: p.lastName, phone: null, locale: "nl-BE", birthOn: null, postalCode: "9000", city: "Gent" });
    expect(JSON.stringify(prefill)).not.toContain("Mia");
    const timeline = JSON.stringify((await eventsOf(p.id)).map((e) => e.data));
    expect(timeline).not.toContain("Mia");
    expect(timeline).not.toContain("998877");
  });

  it("updatePersonFields with onlyEmpty never overwrites and merges externalIds key by key keeping an existing key", async () => {
    const p = await makePerson(h.db, { firstName: "Ann", phone: null, externalIds: { simplybook: "sb-1" } });
    const out = await api.updatePersonFields(tx(), sysCtx(), p.id, { firstName: "Other", phone: "0470 10 20 30", externalIds: { simplybook: "sb-2", mailchimp: "mc-9" } }, { onlyEmpty: true });
    expect(out.changed.sort()).toEqual(["externalIds", "phone"]);
    expect(await row(p.id)).toMatchObject({ firstName: "Ann", phoneE164: "+32470102030", externalIds: { simplybook: "sb-1", mailchimp: "mc-9" } });
    const over = await api.updatePersonFields(tx(), sysCtx(), p.id, { firstName: "Other", preferredChannel: "whatsapp", externalIds: { simplybook: "sb-2" } }, { onlyEmpty: false });
    expect(over.changed.sort()).toEqual(["externalIds", "firstName", "preferredChannel"]);
    expect(await row(p.id)).toMatchObject({ firstName: "Other", preferredChannel: "whatsapp", externalIds: { simplybook: "sb-2", mailchimp: "mc-9" } });
    expect(await api.updatePersonFields(tx(), sysCtx(), p.id, { firstName: "Other" }, { onlyEmpty: false })).toEqual({ changed: [] });
  });

  it("upsertPersonFromImport only fills empty fields and matches by email or legacy id", async () => {
    const p = await makePerson(h.db, { firstName: "Keep", lastName: null, locale: "fr-BE" });
    expect(await api.upsertPersonFromImport(tx(), sysCtx(), { email: p.email, firstName: "Imported", lastName: "Filled", locale: "en", externalIds: { lightspeed: "ls-7" } }, "imp-1")).toEqual({ personId: p.id, outcome: "updated" });
    expect(await row(p.id)).toMatchObject({ firstName: "Keep", lastName: "Filled", locale: "fr-BE", externalIds: { lightspeed: "ls-7" } });
    expect(await api.upsertPersonFromImport(tx(), sysCtx(), { externalIds: { lightspeed: "ls-7" }, firstName: "Again" }, "imp-1")).toEqual({ personId: p.id, outcome: "unchanged" });
    const created = await api.upsertPersonFromImport(tx(), sysCtx(), { email: `imp-${uniq()}@example.com`, firstName: "New", postalCode: "2000" }, "imp-1");
    expect(created.outcome).toBe("created");
    expect(await row(created.personId)).toMatchObject({ acquisition: { source: "import" }, address: { postal_code: "2000", country: "BE" } });
    expect((await eventsOf(created.personId, "person.created"))[0]!.data).toMatchObject({ source: "import", acquisition_source: "import" });
  });

  it("findPersonIdsByEmailHash includes merged rows; resolvePersonIds lists the winner and its losers", async () => {
    const winner = await makePerson(h.db);
    const email = `hash-${uniq()}@example.com`;
    const loser = await makePerson(h.db, { email, emailHash: emailHash(email), mergedIntoPersonId: winner.id });
    expect(await api.findPersonIdsByEmailHash(tx(), emailHash(email))).toEqual([loser.id]);
    expect(await api.resolveCanonicalPersonId(tx(), loser.id)).toBe(winner.id);
    expect(await api.resolvePersonIds(tx(), loser.id)).toEqual([winner.id, loser.id]);
    expect((await api.getPerson(tx(), loser.id))!.id).toBe(winner.id);
  });

  it("restrictProcessing, setPersonTester and listInactiveProfiles", async () => {
    const p = await makePerson(h.db, { isTester: false, createdAt: new Date("2020-01-01T00:00:00Z") });
    await api.restrictProcessing(tx(), sysCtx(), p.id, true);
    expect((await row(p.id)).processingRestrictedAt).toBeInstanceOf(Date);
    await api.restrictProcessing(tx(), sysCtx(), p.id, false);
    expect((await row(p.id)).processingRestrictedAt).toBeNull();
    await api.setPersonTester(tx(), sysCtx(), { personId: p.id, isTester: true });
    expect((await row(p.id)).isTester).toBe(true);
    const ids = await api.listInactiveProfiles(tx(), new Date("2021-01-01T00:00:00Z"), 1000, { leadsOnly: true });
    expect(ids).toContain(p.id);
    await paidOrder(h.db, p.id, "item");
    expect(await api.listInactiveProfiles(tx(), new Date("2021-01-01T00:00:00Z"), 1000, { leadsOnly: true })).not.toContain(p.id);
  });
});

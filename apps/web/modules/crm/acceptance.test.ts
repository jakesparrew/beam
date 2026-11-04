/**
 * crm-P7 acceptance (crm spec 12, "Proposal acceptance and scenario coverage"): the crm rows of
 * the coverage table as integration checks in one file, one `it()` per acceptance line, so the
 * acceptance demo can run it alone. The detailed suites live beside each area.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeProduct, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle, DbOrTx, Tx } from "@beam/db";
import { activityEvents, consentRecords, consentWordings, jobs, orderLines, persons, suppressions, vConsentCurrent } from "@beam/db/schema";
import { SENSITIVE_COLUMNS } from "@beam/db/schema";
import { emailHash, SEGMENT_ALLOWED_FIELDS } from "@beam/core/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
vi.mock("next/server", () => ({ after: () => undefined }));

const api = await import("./api");
const { listTimeline } = await import("./timeline/api");
const { privacy } = await import("./privacy");
const { and, createCtx, eq, setAppDb } = await import("@/lib/ctx");
const { encryptNote } = await import("@/lib/sensitive");
const { makeCtx, resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
let staffId: string;
const uniq = () => randomUUID().slice(0, 8);
const tx = () => h.db as unknown as Tx;
const sys = () => makeCtx(h.db);

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  staffId = (await makeUser(h.db, { roleKey: "owner" })).id;
  for (const purpose of ["newsletter", "events", "member_comms", "b2b"] as const) {
    await h.db.insert(consentWordings).values({ purpose, version: 1, text: { en: purpose, "nl-BE": purpose, "fr-BE": purpose }, publishedAt: new Date("2026-01-01T00:00:00Z") }).onConflictDoNothing();
  }
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function paidOrder(db: DbOrTx, personId: string, kind: "item" | "package") {
  const order = await makeOrder(db, { personId, channel: "portal", status: "paid", subtotalCents: 5000, vatCents: 0, totalCents: 5000 });
  const product = await makeProduct(db, { kind });
  await db.insert(orderLines).values({
    orderId: order.id,
    lineNo: 1,
    productId: product.id,
    sku: product.sku,
    productKind: kind,
    description: { en: kind },
    quantity: 1,
    unitAmountCents: 5000,
    lineTotalCents: 5000,
    vatRatePct: "21.00",
    vatCents: 0,
    pricingTrace: {},
  });
}

async function withEmail() {
  const email = `acc-${uniq()}@example.com`;
  const p = await makePerson(h.db, { email, emailHash: emailHash(email) });
  return { ...p, email };
}

describe("crm acceptance (proposal section 12, scenarios of section 11)", () => {
  it('V1 "customer can register": concurrent sign-ups with one address create one person (3.1 to 3.3)', async () => {
    const email = `register-${uniq()}@example.com`;
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        h.db.transaction((t) => api.findOrCreatePersonByEmail(t, createCtx({ tx: t, actor: { kind: "system", jobId: "" }, durableMode: "immediate" }), { email: ` ${email.toUpperCase()} `, locale: "nl-BE", acquisition: { source: "website" } })),
      ),
    );
    expect(new Set(results.map((r) => r.personId)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('V1 "CRM shows the activity": the timeline lists the person\'s facts newest first (3.35 to 3.37)', async () => {
    const p = await makePerson(h.db);
    await h.db.insert(activityEvents).values({ kind: "interaction.logged", personId: p.id, actor: { kind: "staff", id: staffId }, data: { channel: "call", purpose: "service", summary: "Hello" } });
    const page = await api.listTimeline(h.db, { personId: p.id });
    expect(page.items.map((i) => i.kind)).toContain("interaction.logged");
    expect(page.items[0]!.category).toBe("service");
  });

  it('V1 "data can be exported": the crm export holds the person and their history (section 9)', async () => {
    const p = await withEmail();
    const out = await h.db.transaction((t) => privacy.export(t, p.id));
    expect((out.persons as Array<{ email: string }>)[0]!.email).toBe(p.email);
    expect(out).toHaveProperty("consent_records");
    expect(out).toHaveProperty("activity_events");
  });

  it('V1 "unsubscribe stops marketing within 15 minutes" (scenario 2): withdrawal, suppression and the exit job in one transaction (3.16, 3.17)', async () => {
    const p = await withEmail();
    await api.recordConsent(tx(), sys(), { personId: p.id, purpose: "newsletter", status: "granted", method: "portal", source: "portal", wordingVersion: "newsletter@1" });
    const { suppressionId } = await h.db.transaction((t) => api.unsubscribe(t, createCtx({ tx: t, actor: { kind: "system", jobId: "" } }), { personId: p.id, purpose: "newsletter", method: "unsubscribe_link", source: "unsubscribe_link" }));
    expect(await api.isSuppressed(h.db, p.email, "newsletter")).toBe(true);
    expect((await api.getCurrentConsents(h.db, p.id)).newsletter?.status).toBe("withdrawn");
    const [job] = await h.db.select().from(jobs).where(eq(jobs.idempotencyKey, `supp:${suppressionId}`));
    expect(job).toMatchObject({ kind: "automation.exit_for_suppression", lane: "fast", priority: 1 });
  });

  it('V1 "hard bounces are suppressed" (3.18)', async () => {
    const p = await withEmail();
    await api.addSuppression(tx(), sys(), { email: p.email, scope: "all", reason: "hard_bounce", source: "resend" });
    for (const purpose of ["newsletter", "events", "member_comms", "b2b"] as const) expect(await api.isSuppressed(h.db, p.email, purpose)).toBe(true);
  });

  it('V1 "lead, customer and member content blocks": status is lead, then customer after a paid package, an override wins (3.8, 3.9, 3.12)', async () => {
    const p = await makePerson(h.db);
    expect(await api.getPersonStatus(h.db, p.id)).toMatchObject({ status: "lead", hasActiveMembership: false });
    await paidOrder(h.db, p.id, "item");
    expect((await api.getPersonStatus(h.db, p.id)).status).toBe("lead");
    await paidOrder(h.db, p.id, "package");
    expect((await api.getPersonStatus(h.db, p.id)).derivedStatus).toBe("customer");
    await api.setStatusOverride(tx(), sys(), { personId: p.id, status: "member", reason: "Founding member agreement" });
    expect(await api.getPersonStatus(h.db, p.id)).toMatchObject({ status: "member", derivedStatus: "customer", override: "member", hasActiveMembership: false });
  });

  it('V1 assessment "existing customer record is updated": only empty fields are filled (3.3)', async () => {
    const p = await makePerson(h.db, { firstName: "Kept", lastName: "Name", phone: null });
    const out = await api.findOrCreatePersonByEmail(tx(), sys(), { email: p.email!, firstName: "Other", phone: "0470 98 76 54", locale: "fr-BE", acquisition: { source: "paid_meta" } });
    expect(out).toEqual({ personId: p.id, created: false });
    const [row] = await h.db.select().from(persons).where(eq(persons.id, p.id));
    expect(row).toMatchObject({ firstName: "Kept", phoneE164: "+32470987654", locale: "nl-BE", acquisition: { source: "manual" } });
  });

  it('V1 assessment "a result does not create newsletter consent" (3.15)', async () => {
    const p = await withEmail();
    await api.recordConsent(tx(), sys(), { personId: p.id, purpose: "assessment_result", status: "granted", method: "form", source: "form:stress-check", wordingVersion: "form:stress-check:v1:result_consent" });
    const current = await api.getCurrentConsents(h.db, p.id);
    expect(current.newsletter).toBeNull();
    expect(await h.db.select().from(consentRecords).where(and(eq(consentRecords.personId, p.id), eq(consentRecords.purpose, "newsletter")))).toEqual([]);
  });

  it('V1 assessment "sensitive free text is excluded from AI" (scenario 6): no sensitive column is segmentable and a sensitive note holds only ciphertext (3.23 to 3.27)', async () => {
    const sensitiveCols = new Set([...SENSITIVE_COLUMNS.map((c) => c.column), "value_enc", "body_enc", "is_sensitive"]);
    for (const f of SEGMENT_ALLOWED_FIELDS) expect(sensitiveCols.has(f), f).toBe(false);
    const p = await makePerson(h.db);
    const body = `burn-out ${uniq()}`;
    await h.db.insert(activityEvents).values({ kind: "note.added", personId: p.id, actor: { kind: "staff", id: staffId }, isSensitive: true, data: encryptNote(p.id, body) });
    const page = await listTimeline(h.db, { personId: p.id });
    expect(JSON.stringify(page)).not.toContain(body);
    const [row] = await h.db.select().from(activityEvents).where(eq(activityEvents.personId, p.id));
    expect(Object.keys(row!.data as Record<string, unknown>).sort()).toEqual(["body_enc", "key_version"]);
  });

  it('V1 waitlist "the same person cannot take a second seat": an email variant is flagged as a likely duplicate (3.1, 3.28)', async () => {
    const local = `lies.maes${uniq()}`;
    const a = await makePerson(h.db, { email: `${local}@gmail.com`, emailHash: emailHash(`${local}@gmail.com`) });
    const b = await makePerson(h.db, { email: `${local.replace(".", "")}+spa@gmail.com`, emailHash: emailHash(`${local.replace(".", "")}+spa@gmail.com`) });
    const found = await api.findLikelyDuplicates(h.db, a.id);
    expect(found).toEqual(expect.arrayContaining([expect.objectContaining({ personId: b.id, score: 90 })]));
  });

  it('V1 GDPR "deletion propagates" (scenario 7): erase anonymises the person and keeps a hash-only suppression (section 9)', async () => {
    const p = await withEmail();
    await h.db.transaction((t) => privacy.erase(t, p.id));
    const [row] = await h.db.select().from(persons).where(eq(persons.id, p.id));
    expect(row).toMatchObject({ email: null, firstName: "Deleted" });
    const supp = await h.db.select().from(suppressions).where(eq(suppressions.emailHash, emailHash(p.email)));
    expect(supp).toEqual([expect.objectContaining({ scope: "all", reason: "erased", email: null, personId: null })]);
  });

  it('V1 GDPR "consent history is kept": a grant and a withdrawal both stay; the current state is the withdrawal (3.13, 3.33)', async () => {
    const p = await withEmail();
    await api.recordConsent(tx(), sys(), { personId: p.id, purpose: "events", status: "granted", method: "portal", source: "portal", wordingVersion: "events@1", recordedAt: new Date("2026-02-01T10:00:00Z") });
    await api.recordConsent(tx(), sys(), { personId: p.id, purpose: "events", status: "withdrawn", method: "portal", source: "portal", wordingVersion: "events@1", recordedAt: new Date("2026-03-01T10:00:00Z") });
    expect(await h.db.select().from(consentRecords).where(and(eq(consentRecords.personId, p.id), eq(consentRecords.purpose, "events")))).toHaveLength(2);
    const [current] = await h.db.select().from(vConsentCurrent).where(and(eq(vConsentCurrent.personId, p.id), eq(vConsentCurrent.purpose, "events")));
    expect(current!.status).toBe("withdrawn");
  });

  it('V1 GDPR "suppression survives an import" (3.20)', async () => {
    const p = await withEmail();
    await api.addSuppression(tx(), sys(), { email: p.email, scope: "newsletter", reason: "unsubscribe", source: "unsubscribe_link", personId: p.id });
    const out = await api.recordConsent(tx(), sys(), { personId: p.id, purpose: "newsletter", status: "granted", method: "import", source: `import:${randomUUID()}`, wordingVersion: "legacy-import" });
    expect(out).toEqual({ recordId: null, outcome: "skipped_suppressed" });
    expect(await api.isSuppressed(h.db, p.email, "newsletter")).toBe(true);
  });

  it('Scenario 3 "status from paid transactions, manual correction never overwritten" (3.8 to 3.11)', async () => {
    const p = await makePerson(h.db);
    await api.setStatusOverride(tx(), sys(), { personId: p.id, status: "lead", reason: "Corporate voucher, not a customer" });
    await paidOrder(h.db, p.id, "package");
    expect(await api.getPersonStatus(h.db, p.id)).toMatchObject({ status: "lead", derivedStatus: "customer", override: "lead" });
    const auto = await api.setStatusOverride(tx(), sys(), { personId: p.id, status: "member", reason: "automation step", onlyIfUnset: true, source: "automation" });
    expect(auto.applied).toBe(false);
    expect((await api.getPersonStatus(h.db, p.id)).override).toBe("lead");
  });

  it('R2 "a waiting lead who buys is reclassified correctly" (3.8, 3.10)', async () => {
    const p = await makePerson(h.db);
    expect((await api.getPersonStatus(h.db, p.id)).status).toBe("lead");
    await paidOrder(h.db, p.id, "package");
    expect(await api.getPersonStatus(h.db, p.id)).toMatchObject({ status: "customer", derivedStatus: "customer", override: null });
  });
});

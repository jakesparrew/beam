/**
 * crm-P3 consent and suppression (crm rules 3.13 to 3.22 and 3.53) on a PGlite database: the
 * cross-module api with test contexts and the staff actions through `action()` with a signed-in
 * owner. automation's `requestSuppressionExit`, email's `sendTransactional` and site's
 * `getCurrentLegalVersion` are mocked; the suppression exit is asserted inside the transaction.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, auditLog, consentRecords, consentWordings, suppressions } from "@beam/db/schema";
import { emailHash } from "@beam/core/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p3-consent-secret";
process.env.APP_URL = "https://beam.example.com";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.40" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const mocks = vi.hoisted(() => ({
  exits: [] as { tx: unknown; suppressionId: string }[],
  sent: [] as { template: string; key: string; personId?: string; data: Record<string, unknown> }[],
  legal: null as null | { versionId: string; version: number; requiresReacceptance: boolean },
  jobId: null as string | null,
}));
vi.mock("@/modules/automation/api", () => ({
  requestSuppressionExit: (tx: unknown, input: { suppressionId: string }) => {
    mocks.exits.push({ tx, suppressionId: input.suppressionId });
    return Promise.resolve({ jobId: mocks.jobId });
  },
}));
vi.mock("@/modules/email/api", () => ({
  sendTransactional: (_ctx: unknown, input: { template: string; key: string; personId?: string; data: Record<string, unknown> }) => {
    mocks.sent.push(input);
    return Promise.resolve({ emailMessageId: randomUUID(), jobId: randomUUID() });
  },
  resolveLinkToken: () => Promise.resolve(null),
}));
vi.mock("@/modules/site/api", () => ({
  getCurrentLegalVersion: () => Promise.resolve(mocks.legal ? { ...mocks.legal, publishedAt: new Date(), text: {}, urlByLocale: {} } : null),
}));

const api = await import("./api");
const actions = await import("./actions");
const declarations = await import("../declarations/api");
const auth = await import("@/lib/auth");
const { and, createCtx, ctxState, eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
let owner: { id: string };

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  for (const purpose of ["newsletter", "events", "member_comms", "b2b"] as const) {
    await h.db.insert(consentWordings).values({ purpose, version: 1, text: { en: purpose, "nl-BE": purpose, "fr-BE": purpose }, publishedAt: new Date("2026-01-01T00:00:00Z") });
  }
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  mocks.exits.length = 0;
  mocks.sent.length = 0;
  mocks.legal = null;
  mocks.jobId = null;
  owner = await makeUser(h.db, { roleKey: "owner" });
  const { token } = await auth.createAuthSession(h.db, { userId: owner.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
});

const tx = () => h.db as unknown as Tx;
const ctxAt = (now: Date) => makeCtx(h.db, { now });
const sys = () => makeCtx(h.db);
const person = async (overrides: Parameters<typeof makePerson>[1] = {}) => {
  const email = `p-${randomUUID().slice(0, 8)}@example.com`;
  return makePerson(h.db, { email, emailHash: emailHash(email), ...overrides });
};
const records = (personId: string) => h.db.select().from(consentRecords).where(eq(consentRecords.personId, personId));
const suppressionsOf = (email: string) => h.db.select().from(suppressions).where(eq(suppressions.emailHash, emailHash(email)));
const grant = (personId: string, purpose: "newsletter" | "events" | "member_comms" | "b2b", method: "form" | "portal" | "preference_centre" | "import", recordedAt?: Date) =>
  api.recordConsent(tx(), recordedAt ? ctxAt(recordedAt) : sys(), {
    personId,
    purpose,
    status: "granted",
    method,
    source: method === "form" ? "form:contact" : method === "import" ? "import:test" : method,
    wordingVersion: method === "import" ? "legacy-import" : method === "form" ? "form:contact:v1:newsletter" : `${purpose}@1`,
    ...(recordedAt ? { recordedAt } : {}),
  });

describe("recording consent (rules 3.13, 3.14, 3.15, 3.53)", () => {
  it("3.13 appends rows and the latest record per purpose is the current state", async () => {
    const p = await person();
    await grant(p.id, "newsletter", "portal", new Date("2026-02-01T10:00:00Z"));
    await api.recordConsent(tx(), ctxAt(new Date("2026-03-01T10:00:00Z")), { personId: p.id, purpose: "newsletter", status: "withdrawn", method: "portal", source: "portal", wordingVersion: "unsubscribe" });
    const current = await api.getCurrentConsents(tx(), p.id);
    expect(current.newsletter).toMatchObject({ status: "withdrawn", method: "portal" });
    expect(current.events).toBeNull();
    expect(await records(p.id)).toHaveLength(2);
    const kinds = (await h.db.select().from(activityEvents).where(eq(activityEvents.personId, p.id))).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["consent.granted", "consent.withdrawn", "suppression.added"]));
  });

  it("3.14 a form grant accepts form:<slug>:v<n>:<field> and refuses any other wording string", async () => {
    const p = await person();
    const ok = await api.recordConsent(tx(), sys(), { personId: p.id, purpose: "events", status: "granted", method: "form", source: "form:workshop", wordingVersion: "form:workshop:v3:events_optin" });
    expect(ok.outcome).toBe("recorded");
    await expect(
      api.recordConsent(tx(), sys(), { personId: p.id, purpose: "newsletter", status: "granted", method: "form", source: "form:workshop", wordingVersion: "I agree" }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      api.recordConsent(tx(), sys(), { personId: p.id, purpose: "newsletter", status: "granted", method: "portal", source: "portal", wordingVersion: "newsletter@9" }),
    ).rejects.toMatchObject({ code: "validation", message: "wording_not_published" });
  });

  it("3.15 an assessment result consent never creates newsletter consent", async () => {
    const p = await person();
    const out = await api.recordConsent(tx(), sys(), { personId: p.id, purpose: "assessment_result", status: "granted", method: "form", source: "form:stress-check", wordingVersion: "form:stress-check:v1:result_email" });
    expect(out.outcome).toBe("recorded");
    const rows = await records(p.id);
    expect(rows.map((r) => r.purpose)).toEqual(["assessment_result"]);
    expect((await api.getCurrentConsents(tx(), p.id)).newsletter).toBeNull();
  });

  it("3.53 a marketing grant for a person under 13 is skipped_minor; a valid guardian consent allows it", async () => {
    const minor = await person({ birthOn: "2016-05-01" });
    expect(await grant(minor.id, "newsletter", "form")).toEqual({ recordId: null, outcome: "skipped_minor" });
    expect(await records(minor.id)).toHaveLength(0);
    const adultWithoutBirth = await person({ birthOn: null });
    expect((await grant(adultWithoutBirth.id, "newsletter", "form")).outcome).toBe("recorded");

    mocks.legal = { versionId: randomUUID(), version: 1, requiresReacceptance: false };
    const guardian = await person();
    await declarations.acceptDeclaration(tx(), sys(), { personId: minor.id, guardianPersonId: guardian.id, method: "reception" });
    expect((await grant(minor.id, "newsletter", "form")).outcome).toBe("recorded");
  });
});

describe("withdrawal and suppression (rules 3.16 to 3.18)", () => {
  it("3.16 a withdrawal writes the record and the suppression through addSuppression, which calls requestSuppressionExit in the same transaction", async () => {
    const p = await person();
    await grant(p.id, "newsletter", "portal");
    let inner: unknown;
    await h.db.transaction(async (t) => {
      inner = t;
      const ctx = createCtx({ tx: t, actor: { kind: "system", jobId: "" }, durableMode: "immediate" });
      const out = await api.recordConsent(t, ctx, { personId: p.id, purpose: "newsletter", status: "withdrawn", method: "preference_centre", source: "preference_centre", wordingVersion: "unsubscribe" });
      expect(out.outcome).toBe("recorded");
    });
    const [supp] = await suppressionsOf(p.email!);
    expect(supp).toMatchObject({ scope: "newsletter", reason: "unsubscribe", personId: p.id });
    expect(mocks.exits).toEqual([{ tx: inner, suppressionId: supp!.id }]);
  });

  it("3.16 a rolled-back transaction leaves neither the withdrawal nor the suppression", async () => {
    const p = await person();
    await grant(p.id, "events", "portal");
    await expect(
      h.db.transaction(async (t) => {
        await api.unsubscribe(t, createCtx({ tx: t, actor: { kind: "system", jobId: "" }, durableMode: "immediate" }), { personId: p.id, purpose: "events", method: "unsubscribe_link", source: "unsubscribe_link" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await suppressionsOf(p.email!)).toHaveLength(0);
    expect((await records(p.id)).filter((r) => r.status === "withdrawn")).toHaveLength(0);
  });

  it("edge case 8: unsubscribing an already suppressed address keeps one suppression and still requests the exit", async () => {
    const p = await person();
    await grant(p.id, "newsletter", "portal");
    const first = await api.unsubscribe(tx(), sys(), { personId: p.id, purpose: "newsletter", method: "unsubscribe_link", source: "one_click:a" });
    const second = await api.unsubscribe(tx(), sys(), { personId: p.id, purpose: "newsletter", method: "unsubscribe_link", source: "one_click:b" });
    expect(second.suppressionId).toBe(first.suppressionId);
    expect(await suppressionsOf(p.email!)).toHaveLength(1);
    expect(mocks.exits.map((e) => e.suppressionId)).toEqual([first.suppressionId, first.suppressionId]);
    expect((await records(p.id)).filter((r) => r.status === "withdrawn")).toHaveLength(1);
  });

  it("3.17 unsubscribe from everything withdraws every granted marketing purpose and suppresses scope all", async () => {
    const p = await person();
    await grant(p.id, "newsletter", "portal");
    await grant(p.id, "b2b", "portal");
    await api.unsubscribe(tx(), sys(), { personId: p.id, purpose: "all", method: "portal", source: "portal" });
    const current = await api.getCurrentConsents(tx(), p.id);
    expect(current.newsletter?.status).toBe("withdrawn");
    expect(current.b2b?.status).toBe("withdrawn");
    expect(current.events).toBeNull();
    expect((await suppressionsOf(p.email!)).map((s) => s.scope)).toEqual(["all"]);
  });

  it("3.18 a complaint suppresses scope all and withdraws every marketing purpose of every active person with that address", async () => {
    const p = await person();
    await grant(p.id, "newsletter", "portal");
    await grant(p.id, "member_comms", "portal");
    const out = await api.addSuppression(tx(), sys(), { email: p.email!.toUpperCase(), scope: "all", reason: "complaint", source: "resend_complaint" });
    expect(out.created).toBe(true);
    const withdrawn = (await records(p.id)).filter((r) => r.status === "withdrawn");
    expect(withdrawn.map((r) => r.purpose).sort()).toEqual(["member_comms", "newsletter"]);
    expect(withdrawn.every((r) => r.method === "complaint" && r.wordingVersion === "complaint")).toBe(true);
    expect(await api.isSuppressed(tx(), p.email!, "newsletter")).toBe(true);
    expect(mocks.exits.map((e) => e.suppressionId)).toEqual([out.suppressionId]);
  });
});

describe("suppression lifecycle (rules 3.19 to 3.22)", () => {
  it("3.19 a scoped unsubscribe is lifted only by a newer portal or preference-centre grant", async () => {
    const p = await person();
    await grant(p.id, "newsletter", "portal", new Date("2026-01-10T10:00:00Z"));
    await api.unsubscribe(tx(), ctxAt(new Date()), { personId: p.id, purpose: "newsletter", method: "unsubscribe_link", source: "unsubscribe_link" });
    expect(await api.isSuppressed(tx(), p.email!, "newsletter")).toBe(true);
    expect(await api.isSuppressed(tx(), p.email!, "events")).toBe(false);
    expect((await grant(p.id, "newsletter", "import")).outcome).toBe("skipped_suppressed");
    expect(await api.isSuppressed(tx(), p.email!, "newsletter")).toBe(true);
    const later = new Date(Date.now() + 60_000);
    expect((await grant(p.id, "newsletter", "preference_centre", later)).outcome).toBe("recorded");
    expect(await api.isSuppressed(tx(), p.email!, "newsletter")).toBe(false);
  });

  it("A-23 addSuppression puts the exit job into the context's after-commit list once (fix-w09-crm-review)", async () => {
    const p = await person();
    mocks.jobId = randomUUID();
    const ctx = sys();
    await api.addSuppression(tx(), ctx, { email: p.email!, scope: "newsletter", reason: "manual", source: "staff:test" });
    await api.addSuppression(tx(), ctx, { email: p.email!, scope: "newsletter", reason: "manual", source: "staff:test" });
    expect(ctxState(ctx).enqueuedIds.filter((id) => id === mocks.jobId)).toHaveLength(1);
  });

  it("3.19 scope all never lifts, whatever the grant", async () => {
    const p = await person();
    await api.unsubscribe(tx(), sys(), { personId: p.id, purpose: "all", method: "portal", source: "portal" });
    const later = new Date(Date.now() + 60_000);
    expect((await grant(p.id, "newsletter", "portal", later)).outcome).toBe("skipped_suppressed");
    expect((await grant(p.id, "events", "preference_centre", later)).outcome).toBe("skipped_suppressed");
    expect(await api.isSuppressed(tx(), p.email!, "newsletter")).toBe(true);
  });

  it("3.20 an imported grant is skipped for a suppressed address or after any withdrawal; imports write no suppression", async () => {
    const suppressed = await person();
    await api.addSuppression(tx(), sys(), { email: suppressed.email!, scope: "events", reason: "manual", source: "staff:test" });
    expect((await grant(suppressed.id, "events", "import")).outcome).toBe("skipped_suppressed");

    const withdrew = await person();
    await api.recordConsent(tx(), sys(), { personId: withdrew.id, purpose: "newsletter", status: "withdrawn", method: "import", source: "import:test", wordingVersion: "legacy-import" });
    expect(await suppressionsOf(withdrew.email!)).toHaveLength(0);
    expect((await grant(withdrew.id, "newsletter", "import")).outcome).toBe("skipped_suppressed");

    const clean = await person();
    expect((await grant(clean.id, "newsletter", "import")).outcome).toBe("recorded");
  });

  it("3.21 a form grant after an unsubscribe returns needs_confirmation and sends crm.confirm_resubscribe", async () => {
    const p = await person();
    await grant(p.id, "newsletter", "portal", new Date("2026-01-10T10:00:00Z"));
    await api.unsubscribe(tx(), sys(), { personId: p.id, purpose: "newsletter", method: "unsubscribe_link", source: "unsubscribe_link" });
    const out = await grant(p.id, "newsletter", "form", new Date(Date.now() + 60_000));
    expect(out).toEqual({ recordId: null, outcome: "needs_confirmation" });
    expect(mocks.sent).toHaveLength(1);
    expect(mocks.sent[0]).toMatchObject({ template: "crm.confirm_resubscribe", personId: p.id, data: { purpose: "newsletter" } });
    expect(mocks.sent[0]!.key).toMatch(new RegExp(`^resubscribe:${p.id}:newsletter:\\d{4}-\\d{2}-\\d{2}$`));
    expect(await api.isSuppressed(tx(), p.email!, "newsletter")).toBe(true);
  });

  it("3.22 a restricted person or an unknown address is handled; buildPreferenceUrls builds the three links", async () => {
    const p = await person({ processingRestrictedAt: new Date() });
    expect(await api.isSuppressed(tx(), p.email!, "newsletter")).toBe(true);
    expect(await api.isSuppressed(tx(), `nobody-${randomUUID().slice(0, 6)}@example.com`, "newsletter")).toBe(false);
    expect(api.buildPreferenceUrls("tok_abc", "fr-BE")).toEqual({
      unsubscribeUrl: "https://beam.example.com/fr/preferences/tok_abc?confirm=unsubscribe",
      oneClickPostUrl: "https://beam.example.com/api/public/unsubscribe/tok_abc",
      preferencesUrl: "https://beam.example.com/fr/preferences/tok_abc",
    });
  });
});

describe("staff consent actions", () => {
  it("recordConsent accepts method staff with a form wording version for staff-assisted entry (forms ID10, fix-w09-crm-review)", async () => {
    const p = await person();
    const out = await api.recordConsent(tx(), sys(), {
      personId: p.id,
      purpose: "newsletter",
      status: "granted",
      method: "staff",
      source: `staff:${owner.id}`,
      wordingVersion: "form:intake:v2:newsletter",
    });
    expect(out.outcome).toBe("recorded");
    expect((await records(p.id))[0]).toMatchObject({ purpose: "newsletter", method: "staff", lawfulBasis: "consent", wordingVersion: "form:intake:v2:newsletter", source: `staff:${owner.id}` });
    // a staff grant with a purpose wording stays b2b on legitimate interest only
    await expect(
      api.recordConsent(tx(), sys(), { personId: p.id, purpose: "events", status: "granted", method: "staff", source: `staff:${owner.id}`, wordingVersion: "events@1" }),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("recordStaffConsent grants only b2b on legitimate interest and audits consent.change", async () => {
    const p = await person();
    const b2b = await actions.recordStaffConsent({ personId: p.id, purpose: "b2b", status: "granted" });
    expect(b2b).toMatchObject({ ok: true, data: { outcome: "recorded" } });
    const [row] = await records(p.id);
    expect(row).toMatchObject({ purpose: "b2b", method: "staff", lawfulBasis: "legitimate_interest", source: `staff:${owner.id}`, wordingVersion: "b2b@1" });
    expect(await actions.recordStaffConsent({ personId: p.id, purpose: "newsletter", status: "granted" })).toMatchObject({ ok: false, error: { code: "validation" } });
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "consent.change"), eq(auditLog.personId, p.id)));
    expect(audits).toHaveLength(1);
  });

  it("addManualSuppression suppresses an address forever (reason manual) and audits suppression.add", async () => {
    const email = `manual-${randomUUID().slice(0, 6)}@example.com`;
    const out = await actions.addManualSuppression({ email, scope: "newsletter", note: "Asked by phone" });
    expect(out.ok).toBe(true);
    const [supp] = await suppressionsOf(email);
    expect(supp).toMatchObject({ scope: "newsletter", reason: "manual", source: `staff:${owner.id}` });
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "suppression.add"))).not.toHaveLength(0);
  });

  it("publishConsentWording publishes the next version and refuses a missing locale", async () => {
    const out = await actions.publishConsentWording({ purpose: "events", text: { en: "Events v2", "nl-BE": "Events v2 nl", "fr-BE": "Events v2 fr" } });
    expect(out).toEqual({ ok: true, data: { version: 2 } });
    expect(await api.currentWordingVersion(tx(), "events")).toBe("events@2");
    const missing = await actions.publishConsentWording({ purpose: "events", text: { en: "Only English" } });
    expect(missing).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

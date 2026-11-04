/**
 * Rule 59 (portal; ops-P5): the five portal kinds through `requestMyPrivacyAction`, verified by
 * the customer's session; restrict and object applied at once; the typed confirm word per
 * locale; at most 5 requests per person per day; system requests send no email.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { emailMessages } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", async () => (await import("./ops-p5.fixtures")).headersMock(jar));
vi.mock("next/server", () => ({ after: () => undefined }));

const { eq, setAppDb } = await import("@/lib/ctx");
const { like } = await import("drizzle-orm");
const { makeCtx, resetRuntime } = await import("@/lib/testing");
const actions = await import("./actions");
const { createPrivacyRequest } = await import("./api");
const { requestOf, signInCustomer, useTestKey } = await import("./ops-p5.fixtures");

let h: DbHandle;
beforeAll(async () => {
  useTestKey();
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

const messagesFor = (requestId: string) => h.db.select().from(emailMessages).where(like(emailMessages.idempotencyKey, `privacy:${requestId}:%`));

describe("portal privacy requests", () => {
  it("export, erase, restrict, object and rectify are verified by the session; restrict and object apply at once", async () => {
    const { person } = await signInCustomer(h.db, jar, { locale: "en" });
    const ids: Record<string, string> = {};
    for (const kind of ["export", "restrict", "object", "rectify", "erase"] as const) {
      const res = await actions.requestMyPrivacyAction({ kind, ...(kind === "rectify" ? { rectifyFields: ["phone"] } : {}), ...(kind === "erase" ? { confirmWord: "DELETE" } : {}) });
      expect(res, kind).toMatchObject({ ok: true });
      ids[kind] = (res as { data: { requestId: string } }).data.requestId;
    }
    const rows = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await requestOf(h.db, id)] as const)));
    for (const row of Object.values(rows)) {
      expect(row).toMatchObject({ requestedBy: "customer", personId: person.id, verifiedByUserId: null });
      expect(row.verifiedAt).not.toBeNull();
    }
    expect(rows.export!.status).toBe("running");
    expect(rows.restrict!.status).toBe("done");
    expect(rows.object!.status).toBe("done");
    expect(rows.rectify).toMatchObject({ status: "verified", rectifyFields: ["phone"] });
    expect(rows.erase!.status).toBe("verified");
    expect(rows.erase!.scheduledForAt!.getTime() - rows.erase!.verifiedAt!.getTime()).toBe(86_400_000);
    // The erasure confirmation goes out at verification (rule 64).
    expect((await messagesFor(ids.erase!)).map((m) => m.idempotencyKey)).toEqual([`privacy:${ids.erase}:email:erasure_scheduled`]);

    // Cancel within the window.
    expect(await actions.cancelMyErasure({ requestId: ids.erase })).toMatchObject({ ok: true });
    expect((await requestOf(h.db, ids.erase!)).status).toBe("cancelled");
  });

  it("the erase confirm word is the one of the customer's locale", async () => {
    await signInCustomer(h.db, jar, { locale: "nl-BE" });
    expect(await actions.requestMyPrivacyAction({ kind: "erase", confirmWord: "DELETE" })).toMatchObject({ ok: false, error: { code: "validation", fields: { confirmWord: "wrong_word" } } });
    expect(await actions.requestMyPrivacyAction({ kind: "erase" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.requestMyPrivacyAction({ kind: "erase", confirmWord: "VERWIJDER" })).toMatchObject({ ok: true });

    jar.clear();
    await signInCustomer(h.db, jar, { locale: "fr-BE" });
    expect(await actions.requestMyPrivacyAction({ kind: "erase", confirmWord: "VERWIJDER" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.requestMyPrivacyAction({ kind: "erase", confirmWord: "SUPPRIMER" })).toMatchObject({ ok: true });
  });

  it("allows 5 requests per person per day", async () => {
    await signInCustomer(h.db, jar);
    const results = [];
    for (const kind of ["export", "restrict", "object", "rectify"] as const) {
      results.push(await actions.requestMyPrivacyAction({ kind, ...(kind === "rectify" ? { rectifyFields: ["email"] } : {}) }));
    }
    results.push(await actions.requestMyPrivacyAction({ kind: "erase", confirmWord: "VERWIJDER" }));
    expect(results.every((r) => r.ok)).toBe(true);
    // A sixth request the same day is refused (whatever its kind).
    expect(await actions.requestMyPrivacyAction({ kind: "rectify", rectifyFields: ["phone"] })).toMatchObject({ ok: false, error: { code: "rate_limited" } });
  });

  it("only signed-in customers; staff sessions and visitors are unauthorized", async () => {
    expect(await actions.requestMyPrivacyAction({ kind: "export" })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(await actions.cancelMyErasure({ requestId: "00000000-0000-4000-8000-000000000000" })).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("system requests (retention sweep) are verified and scheduled at once and send no email", async () => {
    const p = await makePerson(h.db, { email: "system-subject@example.com" });
    const { requestId } = await createPrivacyRequest(makeCtx(h.db, { kind: "system", jobId: "privacy.retention_sweep" }), { personId: p.id, kind: "erase", requestedBy: "system", verificationNote: "retention policy ops.marketing_profile" });
    const row = await requestOf(h.db, requestId);
    expect(row).toMatchObject({ status: "verified", requestedBy: "system" });
    expect(row.scheduledForAt).not.toBeNull();
    expect(await messagesFor(requestId)).toEqual([]);
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.personId, p.id))).toEqual([]);
  });
});

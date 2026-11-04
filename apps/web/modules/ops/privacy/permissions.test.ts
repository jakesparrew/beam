/**
 * ops spec section 7, privacy rows (ops-P5): creating a request needs `persons.export`,
 * `persons.erase` or `persons.write` by kind; verifying, running, cancelling, completing a
 * rectification and lifting a restriction need `privacy.run` (run-now of an erasure also
 * `persons.erase`); the portal actions are for signed-in customers only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb, makePerson } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", async () => (await import("./ops-p5.fixtures")).headersMock(jar));
vi.mock("next/server", () => ({ after: () => undefined }));

const { setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const actions = await import("./actions");
const { seedRequest, signInCustomer, signInStaffWith, useTestKey } = await import("./ops-p5.fixtures");

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

const forbidden = { ok: false, error: { code: "forbidden" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };

describe("privacy permissions (ops spec 7)", () => {
  it("create: export needs persons.export, erase/restrict/object persons.erase, rectify persons.write", async () => {
    const p = await makePerson(h.db);
    expect(await actions.createPrivacyRequest({ personId: p.id, kind: "export" })).toMatchObject(unauthorized);

    await signInStaffWith(h.db, jar, ["persons.write"], "customer_service");
    expect(await actions.createPrivacyRequest({ personId: p.id, kind: "export" })).toMatchObject(forbidden);
    expect(await actions.createPrivacyRequest({ personId: p.id, kind: "erase" })).toMatchObject(forbidden);
    expect(await actions.createPrivacyRequest({ personId: p.id, kind: "restrict" })).toMatchObject(forbidden);
    expect(await actions.createPrivacyRequest({ personId: p.id, kind: "rectify", rectifyFields: ["phone"] })).toMatchObject({ ok: true });

    jar.clear();
    await signInStaffWith(h.db, jar, ["persons.export"], "management");
    expect(await actions.createPrivacyRequest({ personId: p.id, kind: "export" })).toMatchObject({ ok: true });
    expect(await actions.createPrivacyRequest({ personId: p.id, kind: "object" })).toMatchObject(forbidden);

    jar.clear();
    await signInStaffWith(h.db, jar, ["persons.erase"], "management");
    expect(await actions.createPrivacyRequest({ personId: p.id, kind: "erase" })).toMatchObject({ ok: true });
    expect(await actions.createPrivacyRequest({ personId: p.id, kind: "erase" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("verify, run now, cancel, complete rectification and lift restriction need privacy.run", async () => {
    const p = await makePerson(h.db);
    const received = await seedRequest(h.db, { personId: p.id, kind: "export" });
    const rectify = await seedRequest(h.db, { personId: p.id, kind: "rectify", status: "verified", rectifyFields: ["email"] });
    const failed = await seedRequest(h.db, { personId: p.id, kind: "erase", status: "failed" });

    await signInStaffWith(h.db, jar, ["persons.export", "persons.erase", "persons.write"], "management");
    expect(await actions.verifyPrivacyRequest({ requestId: received.id, verificationNote: "checked", acknowledgeWarnings: false })).toMatchObject(forbidden);
    expect(await actions.runPrivacyRequestNow({ requestId: failed.id })).toMatchObject(forbidden);
    expect(await actions.cancelPrivacyRequest({ requestId: received.id, reason: "x" })).toMatchObject(forbidden);
    expect(await actions.completeRectification({ requestId: rectify.id })).toMatchObject(forbidden);
    expect(await actions.liftRestriction({ personId: p.id, reason: "x" })).toMatchObject(forbidden);

    jar.clear();
    await signInStaffWith(h.db, jar, ["privacy.run"], "technical_admin");
    // Run-now of an erasure also needs persons.erase.
    expect(await actions.runPrivacyRequestNow({ requestId: failed.id })).toMatchObject(forbidden);
    expect(await actions.verifyPrivacyRequest({ requestId: received.id, verificationNote: "" , acknowledgeWarnings: false })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.verifyPrivacyRequest({ requestId: received.id, verificationNote: "ID card", acknowledgeWarnings: false })).toMatchObject({ ok: true });
    expect(await actions.completeRectification({ requestId: rectify.id })).toMatchObject({ ok: true });
    expect(await actions.liftRestriction({ personId: p.id, reason: "x" })).toMatchObject({ ok: false, error: { code: "not_found" } });

    jar.clear();
    await signInStaffWith(h.db, jar, ["privacy.run", "persons.erase"], "technical_admin");
    expect(await actions.runPrivacyRequestNow({ requestId: failed.id })).toMatchObject({ ok: true });
  });

  it("staff cannot use the portal actions and customers cannot use the staff actions", async () => {
    const p = await makePerson(h.db);
    await signInStaffWith(h.db, jar, ["privacy.run", "persons.erase", "persons.export"], "technical_admin");
    expect(await actions.requestMyPrivacyAction({ kind: "export" })).toMatchObject(unauthorized);
    expect(await actions.cancelMyErasure({ requestId: "00000000-0000-4000-8000-000000000000" })).toMatchObject(unauthorized);

    jar.clear();
    await signInCustomer(h.db, jar);
    expect(await actions.createPrivacyRequest({ personId: p.id, kind: "export" })).toMatchObject(unauthorized);
    expect(await actions.cancelPrivacyRequest({ requestId: "00000000-0000-4000-8000-000000000000", reason: "x" })).toMatchObject(unauthorized);
  });

  it("a customer cannot cancel another person's erasure", async () => {
    const other = await makePerson(h.db);
    const theirs = await seedRequest(h.db, { personId: other.id, kind: "erase", status: "verified", scheduledForAt: new Date(Date.now() + 3_600_000) });
    await signInCustomer(h.db, jar);
    expect(await actions.cancelMyErasure({ requestId: theirs.id })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

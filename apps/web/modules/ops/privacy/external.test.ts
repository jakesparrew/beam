/**
 * Rules 62-63 (cross-module decision 35): ops' external steps `billit`, `mandates` and `resend`
 * (ops-P5). Each is keyed `privacy:<id>:r<run_attempt>:external:<provider>` and recorded before
 * the first module step is enqueued; failures on the last attempt record `failed`, set
 * `needs_manual_followup`, and the local steps still run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { billitParties } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";

vi.mock("next/server", () => ({ after: () => undefined }));

const { setAppDb, sql } = await import("@/lib/ctx");
const { runJobs } = await import("@/lib/job-runner");
const { createFakeIntegrations, makeCtx, resetRuntime, staffActor } = await import("@/lib/testing");
const { rowsOf } = await import("@/lib/sensitive");
const o = await import("./orchestrator");
const { drainPrivacy, privacyJobs, requestOf, useTestKey } = await import("./ops-p5.fixtures");

let h: DbHandle;
let staffId: string;
beforeAll(async () => {
  useTestKey();
  h = await createTestDb();
  setAppDb(h.db);
  staffId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const staff = () => makeCtx(h.db, staffActor({ userId: staffId, permissions: ["privacy.run", "persons.erase"] }));

async function startedErasure(email?: string) {
  const p = await makePerson(h.db, email ? { email } : {});
  const r = await o.createRequest(staff(), { personId: p.id, kind: "erase", requestedBy: "staff" });
  await o.verifyRequest(staff(), { requestId: r.id, verificationNote: "checked", acknowledgeWarnings: true });
  await o.runNow(staff(), r.id);
  return { person: p, requestId: r.id };
}

const external = async (id: string) => ((await requestOf(h.db, id)).report as { external: { provider: string; outcome: string }[] }).external;
const outcomeOf = async (id: string, provider: string) => (await external(id)).find((e) => e.provider === provider)?.outcome;

async function runKey(key: string, integrations: ReturnType<typeof createFakeIntegrations>) {
  const ids = rowsOf<{ id: string }>(await h.db.execute(sql`select id::text as id from jobs where idempotency_key = ${key} and status = 'pending'`)).map((r) => r.id);
  await runJobs({ db: h.db, ids, budgetMs: 30_000, integrations });
}

describe("privacy.erase_external", () => {
  it("records billit, mandates and resend under their keys before the first module step is enqueued", async () => {
    const fakes = createFakeIntegrations();
    const { requestId } = await startedErasure();
    await runKey(`privacy:${requestId}:r1:start:now`, fakes);
    const keys = async () => (await privacyJobs(h.db, requestId)).map((j) => j.key);
    for (const provider of ["billit", "mandates", "resend"]) expect(await keys()).toContain(`privacy:${requestId}:r1:external:${provider}`);
    await runKey(`privacy:${requestId}:r1:external:billit`, fakes);
    await runKey(`privacy:${requestId}:r1:external:mandates`, fakes);
    expect(await keys()).not.toContain(`privacy:${requestId}:r1:step:webinar`);
    await runKey(`privacy:${requestId}:r1:external:resend`, fakes);
    expect(await keys()).toContain(`privacy:${requestId}:r1:step:webinar`);
    expect((await external(requestId)).map((e) => e.provider)).toEqual(expect.arrayContaining(["billit", "mandates", "resend"]));
    await drainPrivacy(h.db, { integrations: fakes });
    expect((await requestOf(h.db, requestId)).status).toBe("done");
  });

  it("Resend: deleteContact gets the person's address; a 404 is not_found", async () => {
    const fakes = createFakeIntegrations();
    const known = await startedErasure("known-contact@example.com");
    fakes.resend.addContact("known-contact@example.com");
    await drainPrivacy(h.db, { integrations: fakes });
    expect(fakes.resend.deletedContacts).toContain("known-contact@example.com");
    expect(await outcomeOf(known.requestId, "resend")).toBe("done");

    const unknown = await startedErasure("never-a-contact@example.com");
    await drainPrivacy(h.db, { integrations: fakes });
    expect(await outcomeOf(unknown.requestId, "resend")).toBe("not_found");
  });

  it("Resend failing on every attempt records failed, sets needs_manual_followup, and the local steps still run", async () => {
    const fakes = createFakeIntegrations();
    const { requestId, person } = await startedErasure("resend-down@example.com");
    for (let i = 0; i < 6; i++) fakes.resend.failNext("retryable");
    await drainPrivacy(h.db, { integrations: fakes });
    const row = await requestOf(h.db, requestId);
    expect(await outcomeOf(requestId, "resend")).toBe("failed");
    expect(row).toMatchObject({ status: "done", needsManualFollowup: true });
    const [p] = rowsOf<{ erased_at: Date | null; email: string | null }>(await h.db.execute(sql`select erased_at, email from persons where id = ${person.id}::uuid`));
    expect(p!.erased_at).not.toBeNull();
    expect(p!.email).toBeNull();
  });

  // One Billit fake for both Billit cases: its party ids are unique per fake, like billit_parties.
  const billitFakes = createFakeIntegrations();

  it("Billit: no reference is not_found without a call; with a reference the party is anonymised", async () => {
    const fakes = billitFakes;
    const none = await startedErasure();
    await drainPrivacy(h.db, { integrations: fakes });
    expect(await outcomeOf(none.requestId, "billit")).toBe("not_found");
    expect(fakes.billit.calls.filter((c) => c.operation === "anonymiseCustomer")).toHaveLength(0);

    const p = await makePerson(h.db);
    const { partyId } = await fakes.billit.upsertParty({ Name: "Test Person", PartyType: "Customer", Email: "billit-party@example.com", ExternalProviderID: `person:${p.id}` });
    await h.db.insert(billitParties).values({ partyKey: `person:${p.id}`, personId: p.id, billitPartyId: partyId });
    const r = await o.createRequest(staff(), { personId: p.id, kind: "erase", requestedBy: "staff" });
    await o.verifyRequest(staff(), { requestId: r.id, verificationNote: "checked", acknowledgeWarnings: true });
    await o.runNow(staff(), r.id);
    await drainPrivacy(h.db, { integrations: fakes });
    expect(await outcomeOf(r.id, "billit")).toBe("done");
    expect(fakes.billit.calls.filter((c) => c.operation === "anonymiseCustomer")).toHaveLength(1);
    expect(fakes.billit.snapshot().parties.find((x) => x.PartyID === partyId)).toMatchObject({ Email: null });
  });

  it("Billit failing on every attempt records failed, sets needs_manual_followup, and the local steps still run", async () => {
    const fakes = billitFakes;
    const p = await makePerson(h.db);
    const { partyId } = await fakes.billit.upsertParty({ Name: "Down Party", PartyType: "Customer", ExternalProviderID: `person:${p.id}` });
    await h.db.insert(billitParties).values({ partyKey: `person:${p.id}`, personId: p.id, billitPartyId: partyId });
    const r = await o.createRequest(staff(), { personId: p.id, kind: "erase", requestedBy: "staff" });
    await o.verifyRequest(staff(), { requestId: r.id, verificationNote: "checked", acknowledgeWarnings: true });
    await o.runNow(staff(), r.id);
    for (let i = 0; i < 6; i++) fakes.billit.failNext("anonymiseCustomer", { status: 503 });
    await drainPrivacy(h.db, { integrations: fakes });
    expect(await outcomeOf(r.id, "billit")).toBe("failed");
    expect(await requestOf(h.db, r.id)).toMatchObject({ status: "done", needsManualFollowup: true });
    expect((await requestOf(h.db, r.id)).report).toMatchObject({ steps: expect.arrayContaining([expect.objectContaining({ module: "crm" })]) });
  });
});

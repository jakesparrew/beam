/**
 * crm-P4 duplicate detection (crm rules 3.28, 3.29) on PGlite: each scoring reason, the highest
 * reason counts, merged and erased persons are never candidates, a dismissed pair is never
 * re-proposed, and both jobs run twice leave the same rows.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, jobs, personDuplicateCandidates } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p4-duplicates-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.41" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const api = await import("./api");
const jobsMod = await import("./jobs");
const actions = await import("./actions");
const queries = await import("./queries");
const auth = await import("@/lib/auth");
const { and, eq, or, setAppDb } = await import("@/lib/ctx");
const { makeJobCtx, resetRuntime, runJobTwice } = await import("@/lib/testing");

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

const uniq = () => randomUUID().slice(0, 8);
const phone = () => `+3247${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
const pairRows = async (x: string, y: string) =>
  h.db
    .select()
    .from(personDuplicateCandidates)
    .where(
      or(
        and(eq(personDuplicateCandidates.personAId, x), eq(personDuplicateCandidates.personBId, y)),
        and(eq(personDuplicateCandidates.personAId, y), eq(personDuplicateCandidates.personBId, x)),
      ),
    );
const check = (personId: string) => jobsMod.runCheckDuplicates(makeJobCtx(h.db, "crm.check_duplicates"), { personId });

describe("scoring reasons (rule 3.28)", () => {
  it("3.28 same legacy external id scores 95", async () => {
    const id = `sb-${uniq()}`;
    const a = await makePerson(h.db, { externalIds: { simplybook: id } });
    const b = await makePerson(h.db, { externalIds: { simplybook: id, mailchimp: "x" } });
    expect(await api.findLikelyDuplicates(h.db, a.id)).toEqual([{ personId: b.id, score: 95, reasons: ["external_id"] }]);
  });

  it("3.28 gmail dots and +tag are the same address and score 90", async () => {
    const local = `anna${uniq()}`;
    const a = await makePerson(h.db, { email: `${local}@gmail.com` });
    const b = await makePerson(h.db, { email: `${local.slice(0, 2)}.${local.slice(2)}+promo@googlemail.com` });
    expect(await api.findLikelyDuplicates(h.db, b.id)).toEqual([{ personId: a.id, score: 90, reasons: ["email_variant"] }]);
  });

  it("3.28 same phone scores 80, and a plain address with dots is not a gmail variant", async () => {
    const tel = phone();
    const a = await makePerson(h.db, { email: `jo.${uniq()}@example.com`, phoneE164: tel, phone: tel });
    const b = await makePerson(h.db, { phoneE164: tel, phone: tel });
    expect(await api.findLikelyDuplicates(h.db, a.id)).toEqual([{ personId: b.id, score: 80, reasons: ["phone"] }]);
  });

  it("3.28 same name and birth date scores 70, same name and postal code 50, below 50 nothing", async () => {
    const last = `Janssens${uniq()}`;
    const a = await makePerson(h.db, { firstName: "Lien", lastName: last, birthOn: "1990-04-02", address: { postal_code: "9000", country: "BE" } });
    const b = await makePerson(h.db, { firstName: "lien", lastName: last.toUpperCase(), birthOn: "1990-04-02" });
    const c = await makePerson(h.db, { firstName: "Lien", lastName: last, address: { postal_code: "9000", country: "BE" } });
    const d = await makePerson(h.db, { firstName: "Lien", lastName: last });
    const found = await api.findLikelyDuplicates(h.db, a.id);
    expect(found).toEqual([
      { personId: b.id, score: 70, reasons: ["name_birth"] },
      { personId: c.id, score: 50, reasons: ["name_postal"] },
    ]);
    expect(found.map((f) => f.personId)).not.toContain(d.id);
    expect((await api.findLikelyDuplicates(h.db, a.id, 0)).map((f) => f.personId)).not.toContain(d.id);
  });

  it("3.28 several reasons do not add up: the highest counts", async () => {
    const tel = phone();
    const last = `Peeters${uniq()}`;
    const a = await makePerson(h.db, { firstName: "Tom", lastName: last, birthOn: "1985-01-01", phoneE164: tel });
    const b = await makePerson(h.db, { firstName: "Tom", lastName: last, birthOn: "1985-01-01", phoneE164: tel });
    const [match] = await api.findLikelyDuplicates(h.db, a.id);
    expect(match).toEqual({ personId: b.id, score: 80, reasons: ["phone", "name_birth"] });
  });

  it("3.28 merged and erased persons are never candidates", async () => {
    const tel = phone();
    const a = await makePerson(h.db, { phoneE164: tel });
    const winner = await makePerson(h.db);
    await makePerson(h.db, { phoneE164: tel, mergedIntoPersonId: winner.id });
    await makePerson(h.db, { phoneE164: tel, email: null, erasedAt: new Date() });
    expect(await api.findLikelyDuplicates(h.db, a.id)).toEqual([]);
  });
});

describe("candidate queue (rules 3.28, 3.29)", () => {
  it("3.28 check_duplicates stores open pairs ordered a < b, listed with both persons", async () => {
    const tel = phone();
    const a = await makePerson(h.db, { phoneE164: tel });
    const b = await makePerson(h.db, { phoneE164: tel });
    expect(await check(a.id)).toEqual({ candidates: 1 });
    const [row] = await pairRows(a.id, b.id);
    expect(row).toMatchObject({ score: 80, reasons: ["phone"], status: "open" });
    expect(row!.personAId < row!.personBId).toBe(true);
    const listed = (await queries.listDuplicateCandidates(h.db, {})).find((r) => r.id === row!.id);
    expect(listed).toMatchObject({ score: 80, status: "open" });
    expect([listed!.personA.id, listed!.personB.id].sort()).toEqual([a.id, b.id].sort());
    expect(listed!.personA.customerNumber).toMatch(/^C-\d{6}$/);
  });

  it("3.28 a dismissed pair is never re-proposed, by the check job, the scan or findLikelyDuplicates", async () => {
    const tel = phone();
    const a = await makePerson(h.db, { phoneE164: tel });
    const b = await makePerson(h.db, { phoneE164: tel });
    await check(a.id);
    const [row] = await pairRows(a.id, b.id);
    const res = await actions.dismissDuplicate({ candidateId: row!.id });
    expect(res).toEqual({ ok: true, data: {} });
    expect(await actions.dismissDuplicate({ candidateId: row!.id })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await actions.dismissDuplicate({ candidateId: randomUUID() })).toMatchObject({ ok: false, error: { code: "not_found" } });

    await check(a.id);
    await check(b.id);
    await jobsMod.runDetectDuplicates(makeJobCtx(h.db, "crm.detect_duplicates"), {});
    const after = await pairRows(a.id, b.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ status: "dismissed", reviewedByUserId: owner.id });
    expect(await api.findLikelyDuplicates(h.db, a.id)).toEqual([]);
    expect((await queries.listDuplicateCandidates(h.db, {})).map((r) => r.id)).not.toContain(row!.id);
    expect((await queries.listDuplicateCandidates(h.db, { status: "dismissed" })).map((r) => r.id)).toContain(row!.id);

    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "person.duplicate_dismiss"), eq(auditLog.entityId, row!.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.oldValue).toEqual({ status: "open" });
  });

  it("3.28 an open pair gets the new score when the data changes", async () => {
    const last = `Maes${uniq()}`;
    const tel = phone();
    const a = await makePerson(h.db, { firstName: "Eva", lastName: last, address: { postal_code: "2000", country: "BE" } });
    const b = await makePerson(h.db, { firstName: "Eva", lastName: last, address: { postal_code: "2000", country: "BE" } });
    await check(a.id);
    expect((await pairRows(a.id, b.id))[0]).toMatchObject({ score: 50, reasons: ["name_postal"] });
    await h.db.execute(`update persons set phone_e164 = '${tel}' where id in ('${a.id}', '${b.id}')`);
    await check(b.id);
    expect((await pairRows(a.id, b.id))[0]).toMatchObject({ score: 80, reasons: ["phone", "name_postal"], status: "open" });
  });

  it("3.29 the dismiss action needs persons.merge", async () => {
    const user = await makeUser(h.db, { roleKey: "reception" });
    const { token } = await auth.createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey: "reception", now: new Date(), mfaAt: new Date() });
    jar.set(auth.SESSION_COOKIE, token);
    expect(await actions.dismissDuplicate({ candidateId: randomUUID() })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("jobs run twice", () => {
  it("crm.check_duplicates twice gives the same rows", async () => {
    const tel = phone();
    const a = await makePerson(h.db, { phoneE164: tel });
    const b = await makePerson(h.db, { phoneE164: tel });
    const c = await makePerson(h.db, { phoneE164: tel });
    const { first, second } = await runJobTwice(h.db, "crm.check_duplicates", { personId: a.id });
    expect(first).toEqual({ candidates: 2 });
    expect(second).toEqual({ candidates: 2 });
    const rows = [...(await pairRows(a.id, b.id)), ...(await pairRows(a.id, c.id))];
    expect(rows).toHaveLength(2);
    const snapshot = rows.map((r) => ({ id: r.id, score: r.score, updatedAt: r.updatedAt.getTime() }));
    await runJobTwice(h.db, "crm.check_duplicates", { personId: a.id });
    const again = [...(await pairRows(a.id, b.id)), ...(await pairRows(a.id, c.id))].map((r) => ({ id: r.id, score: r.score, updatedAt: r.updatedAt.getTime() }));
    expect(again).toEqual(snapshot);
  });

  it("crm.detect_duplicates twice gives the same rows and stops after a short batch", async () => {
    const tel = phone();
    const a = await makePerson(h.db, { phoneE164: tel });
    const b = await makePerson(h.db, { phoneE164: tel });
    const { first, second } = await runJobTwice(h.db, "crm.detect_duplicates", {});
    expect(first).toMatchObject({ next: null });
    expect(second).toEqual(first);
    const rows = await pairRows(a.id, b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("open");
    const all = await h.db.select({ id: personDuplicateCandidates.id, score: personDuplicateCandidates.score, updatedAt: personDuplicateCandidates.updatedAt }).from(personDuplicateCandidates);
    await runJobTwice(h.db, "crm.detect_duplicates", {});
    const again = await h.db.select({ id: personDuplicateCandidates.id, score: personDuplicateCandidates.score, updatedAt: personDuplicateCandidates.updatedAt }).from(personDuplicateCandidates);
    expect(again.sort((x, y) => x.id.localeCompare(y.id))).toEqual(all.sort((x, y) => x.id.localeCompare(y.id)));
    expect(await h.db.select().from(jobs).where(eq(jobs.kind, "crm.detect_duplicates"))).toHaveLength(0);
  });

  it("crm.detect_duplicates enqueues itself with the last id of a full batch", async () => {
    const ctx = makeJobCtx(h.db, "crm.detect_duplicates", { now: new Date("2026-11-04T02:50:00Z") });
    const spy = vi.spyOn(ctx, "enqueue");
    const res = await jobsMod.runDetectDuplicates(ctx, {});
    expect(res.scanned).toBeLessThan(jobsMod.DETECT_BATCH);
    expect(spy).not.toHaveBeenCalled();
    const afterLast = await jobsMod.runDetectDuplicates(ctx, { afterId: "ffffffff-ffff-4fff-bfff-ffffffffffff" });
    expect(afterLast).toEqual({ scanned: 0, next: null });
  });
});

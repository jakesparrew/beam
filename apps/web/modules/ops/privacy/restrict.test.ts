/**
 * Rules 65-66 (ops-P5): restriction and objection. crm's `restrictProcessing` and automation's
 * `exitAllForPerson` are spied (wrapping the real functions) to check their arguments and that
 * they run in the caller's transaction.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { consentRecords, processingRestrictions, suppressions } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type * as AutomationApi from "@/modules/automation/api";
import type * as CrmApi from "@/modules/crm/api";

const spy = vi.hoisted(() => ({
  restrict: [] as { tx: unknown; personId: string; restricted: boolean }[],
  exit: [] as { tx: unknown; personId: string; reason: string }[],
}));

vi.mock("next/server", () => ({ after: () => undefined }));
// crm's api barrel imports ops' api (a cycle), so the spy sits on the file that defines the function.
vi.mock("@/modules/crm/persons/api", async (importOriginal) => {
  const real = await importOriginal<Pick<typeof CrmApi, "restrictProcessing">>();
  return {
    ...real,
    restrictProcessing: async (...args: Parameters<typeof real.restrictProcessing>) => {
      spy.restrict.push({ tx: args[0], personId: args[2], restricted: args[3] });
      return real.restrictProcessing(...args);
    },
  };
});
vi.mock("@/modules/automation/api", async (importOriginal) => {
  const real = await importOriginal<typeof AutomationApi>();
  return {
    ...real,
    exitAllForPerson: async (...args: Parameters<typeof real.exitAllForPerson>) => {
      spy.exit.push({ tx: args[0], personId: args[2], reason: args[3] });
      return real.exitAllForPerson(...args);
    },
  };
});

const { createCtx, eq, setAppDb, sql } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");
const { makeCtx, resetRuntime, staffActor } = await import("@/lib/testing");
const { recordConsent, getCurrentConsents } = await import("@/modules/crm/api");
const o = await import("./orchestrator");
const { requestOf, useTestKey } = await import("./ops-p5.fixtures");

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
beforeEach(() => {
  spy.restrict.length = 0;
  spy.exit.length = 0;
});

const actor = () => staffActor({ userId: staffId, permissions: ["privacy.run", "persons.erase"] });
const inProfile = async (personId: string) =>
  Number(rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from v_person_profile where person_id = ${personId}::uuid`))[0]!.n) === 1;
const restrictedAt = async (personId: string) => rowsOf<{ at: Date | null }>(await h.db.execute(sql`select processing_restricted_at as at from persons where id = ${personId}::uuid`))[0]!.at;

async function withMarketingConsent() {
  const p = await makePerson(h.db, { email: `consent-${Math.random().toString(36).slice(2)}@example.com` });
  await recordConsent(h.db as never, makeCtx(h.db), { personId: p.id, purpose: "newsletter", status: "granted", method: "form", source: "form:test", wordingVersion: "form:test:v1:newsletter" });
  return p;
}

describe("restriction and objection", () => {
  it("restriction: row and restrictProcessing(true) in one transaction, out of v_person_profile, consents withdrawn, enrolments exited as restricted", async () => {
    const p = await withMarketingConsent();
    expect(await inProfile(p.id)).toBe(true);
    let txSeen: unknown;
    await h.db.transaction(async (tx) => {
      txSeen = tx;
      const ctx = createCtx({ tx, actor: actor() });
      const r = await o.createRequest(ctx, { personId: p.id, kind: "restrict", requestedBy: "staff" });
      const v = await o.verifyRequest(ctx, { requestId: r.id, verificationNote: "checked", acknowledgeWarnings: false });
      expect(v.status).toBe("done");
    });
    expect(spy.restrict).toEqual([{ tx: txSeen, personId: p.id, restricted: true }]);
    expect(spy.exit).toEqual([{ tx: txSeen, personId: p.id, reason: "restricted" }]);
    const [row] = await h.db.select().from(processingRestrictions).where(eq(processingRestrictions.personId, p.id));
    expect(row).toMatchObject({ reason: "accuracy_contested" });
    expect(row!.privacyRequestId).not.toBeNull();
    expect(await restrictedAt(p.id)).not.toBeNull();
    expect(await inProfile(p.id)).toBe(false);
    expect((await getCurrentConsents(h.db, p.id)).newsletter?.status).toBe("withdrawn");
    const withdrawn = await h.db.select().from(consentRecords).where(eq(consentRecords.personId, p.id));
    expect(withdrawn.find((c) => c.status === "withdrawn")).toMatchObject({ method: "staff", source: "privacy_restriction" });
  });

  it("objection: consents withdrawn, exit as objected, suppression all/manual, no flag and no restriction row", async () => {
    const p = await withMarketingConsent();
    const ctx = makeCtx(h.db, actor());
    const r = await o.createRequest(ctx, { personId: p.id, kind: "object", requestedBy: "staff" });
    await o.verifyRequest(ctx, { requestId: r.id, verificationNote: "checked", acknowledgeWarnings: false });
    expect((await requestOf(h.db, r.id)).status).toBe("done");
    expect(spy.exit.map((e) => e.reason)).toEqual(["objected"]);
    expect(spy.restrict).toEqual([]);
    expect(await restrictedAt(p.id)).toBeNull();
    expect(await h.db.select().from(processingRestrictions).where(eq(processingRestrictions.personId, p.id))).toEqual([]);
    expect(await inProfile(p.id)).toBe(true);
    const supp = await h.db.select().from(suppressions).where(eq(suppressions.personId, p.id));
    expect(supp).toContainEqual(expect.objectContaining({ scope: "all", reason: "manual" }));
    expect((await getCurrentConsents(h.db, p.id)).newsletter?.status).toBe("withdrawn");
  });

  it("lifting deletes the row, calls restrictProcessing(false) and never re-grants consent", async () => {
    const p = await withMarketingConsent();
    const ctx = makeCtx(h.db, actor());
    const r = await o.createRequest(ctx, { personId: p.id, kind: "restrict", requestedBy: "staff" });
    await o.verifyRequest(ctx, { requestId: r.id, verificationNote: "checked", acknowledgeWarnings: false });
    spy.restrict.length = 0;
    await o.liftRestriction(ctx, { personId: p.id, reason: "accuracy confirmed" });
    expect(spy.restrict).toEqual([{ tx: ctx.tx, personId: p.id, restricted: false }]);
    expect(await h.db.select().from(processingRestrictions).where(eq(processingRestrictions.personId, p.id))).toEqual([]);
    expect(await restrictedAt(p.id)).toBeNull();
    expect((await getCurrentConsents(h.db, p.id)).newsletter?.status).toBe("withdrawn");
    await expect(o.liftRestriction(ctx, { personId: p.id, reason: "again" })).rejects.toMatchObject({ code: "not_found" });
  });
});

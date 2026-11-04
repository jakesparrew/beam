import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { cookieConsents, jobs, privacyRequests, retentionPolicies, termsAcceptances } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { ensureTermsVersion, makeOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";

vi.mock("../privacy/api", () => ({
  /** Stand-in for ops-P5's `createPrivacyRequest`: a system erase request, verified at once. */
  createPrivacyRequest: async (ctx: { tx: Tx }, input: { personId: string; kind: "erase"; requestedBy: "system" }) => {
    const { privacyRequests: table } = await import("@beam/db/schema");
    const [row] = await ctx.tx
      .insert(table)
      .values({ personId: input.personId, kind: input.kind, requestedBy: input.requestedBy, status: "verified", verifiedAt: new Date(), scheduledForAt: new Date(), dueOn: "2099-01-01" })
      .returning({ id: table.id });
    return { requestId: row!.id };
  },
}));

const { and, eq, inArray, sql } = await import("@/lib/ctx");
const { makeJobCtx, resetRuntime } = await import("@/lib/testing");
const { rowsOf } = await import("@/lib/sensitive");
const { effectiveDays, sweepRetention } = await import("./jobs");
const { genericSweep, GENERIC_SWEEP_TABLES } = await import("./generic-sweep");
const { makeBooking } = await import("../stats/ops-p2.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await h.db.update(retentionPolicies).set({ isActive: false });
});

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ctx = () => makeJobCtx(h.db, "privacy.retention_sweep");

async function policy(key: string, over: Partial<typeof retentionPolicies.$inferInsert> = {}) {
  await h.db
    .insert(retentionPolicies)
    .values({ key, tableName: over.tableName ?? "audit_log", days: 30, action: "delete", description: key, ...over, isActive: over.isActive ?? true })
    .onConflictDoUpdate({ target: retentionPolicies.key, set: { isActive: over.isActive ?? true, days: over.days ?? 30, runOrder: over.runOrder ?? 100, batchSize: over.batchSize ?? 1000 } });
}
const policyRow = async (key: string) => (await h.db.select().from(retentionPolicies).where(eq(retentionPolicies.key, key)))[0]!;

async function cookieConsent(createdAt: Date) {
  const [row] = await h.db
    .insert(cookieConsents)
    .values({ consentKey: randomUUID(), choices: { analytics: false, marketing: false }, bannerVersion: 1, action: "reject_all", locale: "nl-BE", createdAt, recordedAt: createdAt })
    .returning({ id: cookieConsents.id });
  return row!.id;
}
async function termsAcceptance(createdAt: Date) {
  const person = await makePerson(h.db);
  const version = await ensureTermsVersion(h.db);
  const [row] = await h.db
    .insert(termsAcceptances)
    .values({ personId: person.id, pageVersionId: version.id, legalKey: "terms", context: "signup", idempotencyKey: `terms:${randomUUID()}`, acceptedAt: createdAt, createdAt })
    .returning({ id: termsAcceptances.id });
  return row!.id;
}
const exists = async (table: typeof cookieConsents | typeof termsAcceptances, id: string) => (await h.db.select({ id: table.id }).from(table).where(eq(table.id, id))).length === 1;

describe("retention sweep (ops rule 68)", () => {
  it("runs active policies by run_order; keep and inactive policies are skipped; a key without handler records no_handler", async () => {
    const calls: string[] = [];
    const handler = (key: string) => () => {
      calls.push(key);
      return Promise.resolve(0);
    };
    const keys = ["crm.t_a", "crm.t_b", "crm.t_c", "crm.t_keep", "crm.t_off"];
    const registry = { crm: { sweep: Object.fromEntries(keys.map((k) => [k, handler(k)])) } };
    await policy("crm.t_a", { runOrder: 30 });
    await policy("crm.t_b", { runOrder: 10 });
    await policy("crm.t_c", { runOrder: 20 });
    await policy("crm.t_keep", { runOrder: 5, action: "keep", days: null });
    await policy("crm.t_off", { runOrder: 6, isActive: false });
    await policy("booking.t_missing", { runOrder: 40, tableName: "bookings" });

    const result = await sweepRetention(ctx(), {}, { registry });
    expect(calls).toEqual(["crm.t_b", "crm.t_c", "crm.t_a"]);
    expect(result.policies.map((p) => [p.key, p.status])).toEqual([
      ["crm.t_b", "ok"],
      ["crm.t_c", "ok"],
      ["crm.t_a", "ok"],
      ["booking.t_missing", "no_handler"],
    ]);
    expect(await policyRow("booking.t_missing")).toMatchObject({ lastRunStatus: "no_handler", lastRunRows: 0 });
    expect((await policyRow("crm.t_keep")).lastRunAt).toBeNull();
    expect((await policyRow("crm.t_a")).lastRunStatus).toBe("ok");
  });

  it("re-calls a module handler while it returns a full batch; an error stops only that policy", async () => {
    const sizes = [2, 2, 1];
    const cutoffs: Date[] = [];
    const rewrite: string[] = [];
    const registry = {
      crm: {
        sweep: {
          "crm.t_batch": async (tx: Tx, cutoff: Date) => {
            cutoffs.push(cutoff);
            rewrite.push(rowsOf<{ v: string }>(await tx.execute(sql`select current_setting('beam.allow_rewrite', true) as v`))[0]!.v);
            return sizes.shift() ?? 0;
          },
          "crm.t_boom": () => Promise.reject(new Error("boom")),
        },
      },
    };
    await policy("crm.t_boom", { runOrder: 1 });
    await policy("crm.t_batch", { runOrder: 2, batchSize: 2, days: 10 });
    const result = await sweepRetention(ctx(), {}, { registry });
    expect(result.policies).toEqual([
      { key: "crm.t_boom", status: "error", rows: 0, calls: 0 },
      { key: "crm.t_batch", status: "ok", rows: 5, calls: 3 },
    ]);
    expect(rewrite).toEqual(["on", "on", "on"]);
    expect(Math.abs(cutoffs[0]!.getTime() - ago(10).getTime())).toBeLessThan(60_000);
    expect(await policyRow("crm.t_batch")).toMatchObject({ lastRunRows: 5, lastRunStatus: "ok" });
    expect((await policyRow("crm.t_boom")).lastRunStatus).toBe("error");
    // outside the handler the session setting is off again
    expect(rowsOf<{ v: string | null }>(await h.db.execute(sql`select current_setting('beam.allow_rewrite', true) as v`))[0]!.v ?? "").not.toBe("on");
  });

  it("continues in a new job when the call budget is spent, keyed retention:<runOn>:<key>:<n>", async () => {
    const registry = { crm: { sweep: { "crm.t_long": () => Promise.resolve(2) } } };
    await policy("crm.t_long", { runOrder: 1, batchSize: 2 });
    const result = await sweepRetention(ctx(), { runOn: "2026-11-04" }, { registry, maxCallsPerJob: 3 });
    expect(result.policies[0]).toMatchObject({ key: "crm.t_long", rows: 6, calls: 3, continued: true });
    const [job] = await h.db.select({ payload: jobs.payload }).from(jobs).where(eq(jobs.idempotencyKey, "retention:2026-11-04:crm.t_long:1"));
    expect(job!.payload).toEqual({ runOn: "2026-11-04", policyKey: "crm.t_long", n: 1 });
    await sweepRetention(ctx(), { runOn: "2026-11-04", policyKey: "crm.t_long", n: 1 }, { registry, maxCallsPerJob: 1 });
    expect((await policyRow("crm.t_long")).lastRunRows).toBe(8);
  });

  it("accounting-linked keys never sweep a record younger than 3653 days", () => {
    expect(effectiveDays({ key: "finance.invoices", days: 30 })).toBe(3653);
    expect(effectiveDays({ key: "site.terms_acceptances", days: 395 })).toBe(3653);
    expect(effectiveDays({ key: "site.cookie_consents", days: 395 })).toBe(395);
  });
});

describe("generic handler (ops rule 68, GENERIC_SWEEP_TABLES)", () => {
  it("deletes only from allow-listed tables", async () => {
    expect(Object.keys(GENERIC_SWEEP_TABLES).sort()).toEqual(["cookie_consents", "page_edit_requests", "terms_acceptances"]);
    await expect(genericSweep(h.db as unknown as Tx, "persons", new Date(), 10)).rejects.toThrow(/not allowed/);
  });

  it("refuses append-only cookie_consents and terms_acceptances without beam.allow_rewrite", async () => {
    const consent = await cookieConsent(ago(400));
    const terms = await termsAcceptance(ago(4000));
    await expect(genericSweep(h.db as unknown as Tx, "cookie_consents", ago(395), 100)).rejects.toThrow();
    await expect(genericSweep(h.db as unknown as Tx, "terms_acceptances", ago(3653), 100)).rejects.toThrow();
    expect(await exists(cookieConsents, consent)).toBe(true);
    expect(await exists(termsAcceptances, terms)).toBe(true);
  });

  it("deletes only older rows of site's tables when the owner registers no handler, under beam.allow_rewrite", async () => {
    const oldConsent = await cookieConsent(ago(400));
    const newConsent = await cookieConsent(ago(10));
    const oldTerms = await termsAcceptance(ago(3700));
    const newTerms = await termsAcceptance(ago(3000));
    await policy("site.cookie_consents", { tableName: "cookie_consents", days: 395, runOrder: 1 });
    await policy("site.terms_acceptances", { tableName: "terms_acceptances", days: 400, runOrder: 2 });
    const result = await sweepRetention(ctx(), {}, { registry: {} });
    expect(result.policies.map((p) => p.status)).toEqual(["ok", "ok"]);
    expect(await exists(cookieConsents, oldConsent)).toBe(false);
    expect(await exists(cookieConsents, newConsent)).toBe(true);
    // days 400 is raised to the 3653-day accounting horizon
    expect(await exists(termsAcceptances, oldTerms)).toBe(false);
    expect(await exists(termsAcceptances, newTerms)).toBe(true);
  });
});

describe("marketing profile and contact policies (ops rules 69, 69a)", () => {
  const systemErases = () =>
    h.db
      .select({ personId: privacyRequests.personId })
      .from(privacyRequests)
      .where(and(eq(privacyRequests.requestedBy, "system"), eq(privacyRequests.kind, "erase")));

  async function marketingPolicies() {
    await policy("ops.marketing_contact", { tableName: "persons", days: 730, action: "anonymise", runOrder: 10 });
    await policy("ops.marketing_profile", { tableName: "persons", days: 1095, action: "anonymise", runOrder: 11 });
  }

  it("skip people with a future booking or an open request; contacts never include buyers, bookers or grant holders", async () => {
    const old = { createdAt: ago(1200), isTester: false };
    const lead = await makePerson(h.db, old);
    const futureBooker = await makePerson(h.db, old);
    await makeBooking(h.db, { personId: futureBooker.id, startsAt: new Date(Date.now() + 5 * DAY), status: "confirmed", createdAt: ago(1200) });
    const openRequest = await makePerson(h.db, old);
    await h.db.insert(privacyRequests).values({ personId: openRequest.id, kind: "export", requestedBy: "customer", dueOn: "2099-01-01" });
    const buyer = await makePerson(h.db, old);
    await makeOrder(h.db, { personId: buyer.id, status: "paid", paidAt: ago(1100), createdAt: ago(1100) });
    const pastBooker = await makePerson(h.db, old);
    await makeBooking(h.db, { personId: pastBooker.id, startsAt: ago(1150), status: "attended", createdAt: ago(1150) });
    const grantHolder = await makePerson(h.db, old);
    await makeCreditGrant(h.db, { personId: grantHolder.id, status: "exhausted", createdAt: ago(1150) });

    await policy("ops.marketing_contact", { tableName: "persons", days: 730, action: "anonymise", runOrder: 10 });
    await sweepRetention(ctx(), {});
    const contacts = (await systemErases()).map((r) => r.personId);
    expect(contacts).toContain(lead.id);
    for (const p of [futureBooker, openRequest, buyer, pastBooker, grantHolder]) expect(contacts, p.id).not.toContain(p.id);

    await marketingPolicies();
    await sweepRetention(ctx(), {});
    const all = (await systemErases()).map((r) => r.personId);
    expect(all).toEqual(expect.arrayContaining([lead.id, buyer.id, pastBooker.id, grantHolder.id]));
    expect(all).not.toContain(futureBooker.id);
    expect(all).not.toContain(openRequest.id);
    expect(all.filter((id) => id === lead.id)).toHaveLength(1);
  });

  it("create at most 200 system erase requests per night together, contacts first", async () => {
    await h.db.delete(privacyRequests);
    await h.db.execute(sql`insert into persons (email, first_name, last_name, locale, is_tester, acquisition, created_at)
      select 'cap-lead-' || g || '@example.com', 'Lead', 'Cap ' || g, 'nl-BE', false, '{"source":"manual"}'::jsonb, now() - interval '1200 days'
      from generate_series(1, 150) g`);
    const customers: string[] = [];
    for (let i = 0; i < 80; i++) {
      const p = await makePerson(h.db, { createdAt: ago(1300), isTester: false, email: `cap-customer-${i}@example.com` });
      await makeOrder(h.db, { personId: p.id, status: "paid", paidAt: ago(1250), createdAt: ago(1250) });
      customers.push(p.id);
    }
    await marketingPolicies();
    await sweepRetention(ctx(), {});
    const erased = (await systemErases()).map((r) => r.personId);
    expect(erased).toHaveLength(200);
    const leadIds = rowsOf<{ id: string }>(await h.db.execute(sql`select id::text as id from persons where email like 'cap-lead-%'`)).map((r) => r.id);
    expect(erased).toEqual(expect.arrayContaining(leadIds));
    // the earlier test's leads come first too; the profiles fill what the contacts left of the cap
    const profiles = erased.filter((id) => customers.includes(id)).length;
    expect(profiles).toBeGreaterThan(40);
    expect(profiles).toBeLessThan(50 + 1);

    // a second run the same night adds nothing
    await sweepRetention(ctx(), {});
    expect(await systemErases()).toHaveLength(200);
    expect(await h.db.select({ id: privacyRequests.id }).from(privacyRequests).where(inArray(privacyRequests.personId, customers))).toHaveLength(profiles);
  }, 120_000);
});

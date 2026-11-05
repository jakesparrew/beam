/**
 * fix-w23-leftovers (ops-P10 request): the demo seeds of crm, commerce and credits add a few
 * ordinary (non-tester) demo customers with paid orders, a 10-session package and one B2B
 * opportunity, keep the tester demo persons as they are, and create nothing on a second run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb, makeUser } from "@beam/db/testing";

vi.mock("next/headers", () => ({
  cookies: () => Promise.resolve({ get: () => undefined, set: () => undefined, delete: () => undefined }),
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock("next/server", async (orig) => ({ ...(await orig<object>()), after: () => undefined }));
vi.stubEnv("APP_ENV", "local");
vi.stubEnv("INTEGRATIONS", "fake");
vi.stubEnv("APP_URL", "https://app.example.com");
vi.stubEnv("AUTH_SECRET", "fix-w23-leftovers-auth-secret-0123456789");
vi.stubEnv("SENSITIVE_DATA_KEY_V1", Buffer.alloc(32, 5).toString("base64"));
vi.stubEnv("VOUCHER_CODE_SECRET", "fix-w23-leftovers-voucher-secret-0123456");

const { createFakeIntegrations, makeCtx, resetRuntime } = await import("@/lib/testing");
const { runSeed } = await import("@/scripts/seed-demo");
const { DEMO_SEEDS } = await import("@/registry/seeds.generated");
const { sql } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");
const { DEMO_CUSTOMERS, DEMO_OPPORTUNITY, demoCustomerEmail } = await import("./seed");
const { DEMO_CUSTOMER_ORDERS } = await import("../commerce/seed");

/** 12:00 Brussels on a Thursday. */
const NOW = new Date("2026-10-15T10:00:00.000Z");
const SEEDS = DEMO_SEEDS.filter((s) => ["platform", "crm", "site", "forms", "commerce", "credits"].includes(s.module));

let h: DbHandle;
const EMAILS = () => sql.raw(`(${DEMO_CUSTOMERS.map((c) => `'${demoCustomerEmail(c.slug)}'`).join(", ")})`);
const one = async <T,>(q: ReturnType<typeof sql>) => rowsOf<T>(await h.db.execute(q))[0]!;
const n = async (q: ReturnType<typeof sql>) => Number((await one<{ n: number }>(q)).n);

beforeAll(async () => {
  h = await createTestDb();
  makeCtx(h.db, { integrations: createFakeIntegrations() });
  // platform's demo staff need the demo credentials; a staff user owns the demo opportunity.
  await makeUser(h.db, { roleKey: "sales", email: "fix-w23-sales@example.com" });
  await runSeed(h.db, { profile: "demo", env: { APP_ENV: "local" }, clock: NOW, seeds: SEEDS, runJobsAfter: false, log: () => undefined });
}, 300_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  resetRuntime();
  await h?.close();
});

describe("non-tester demo customers", () => {
  it("are ordinary customers at @demo.beam.be; the tester demo persons stay testers", async () => {
    expect(await n(sql`select count(*)::int as n from persons where email in ${EMAILS()} and not is_tester and email_hash is not null`)).toBe(DEMO_CUSTOMERS.length);
    expect(await n(sql`select count(*)::int as n from persons where email like 'crm-demo-%@example.com' and not is_tester`)).toBe(0);
    expect(await n(sql`select count(*)::int as n from persons where email like 'crm-demo-%@example.com'`)).toBe(40);
  });

  it("have paid orders in the past, each with a paid payment and an invoice", async () => {
    const paid = await n(sql`select count(*)::int as n from orders o join persons p on p.id = o.person_id
      where p.email in ${EMAILS()} and o.status = 'paid' and o.paid_at < ${NOW.toISOString()}::timestamptz`);
    expect(paid).toBe(DEMO_CUSTOMER_ORDERS.length);
    expect(await n(sql`select count(distinct o.id)::int as n from orders o join persons p on p.id = o.person_id join payments pay on pay.order_id = o.id
      where p.email in ${EMAILS()} and pay.status = 'paid'`)).toBe(DEMO_CUSTOMER_ORDERS.length);
    expect(await n(sql`select count(distinct i.order_id)::int as n from invoices i join persons p on p.id = i.person_id where p.email in ${EMAILS()}`)).toBe(DEMO_CUSTOMER_ORDERS.length);
    expect(await n(sql`select count(distinct date_trunc('month', o.paid_at))::int as n from orders o join persons p on p.id = o.person_id where p.email in ${EMAILS()}`)).toBeGreaterThan(1);
  });

  it("one of them holds the 10-session package and one a bonus grant", async () => {
    expect(await n(sql`select count(*)::int as n from credit_grants g join persons p on p.id = g.person_id
      where p.email in ${EMAILS()} and g.source = 'purchase' and g.units_granted = 10 and g.status = 'active'`)).toBe(1);
    expect(await n(sql`select count(*)::int as n from credit_grants g join persons p on p.id = g.person_id where p.email in ${EMAILS()} and g.source = 'bonus'`)).toBe(1);
  });

  it("one open B2B opportunity of a demo company", async () => {
    const o = await one<{ stage: string; value_cents: number; owner: string | null }>(
      sql`select o.stage::text as stage, o.value_cents, o.owner_user_id as owner from opportunities o where o.title = ${DEMO_OPPORTUNITY.title}`,
    );
    expect(o).toMatchObject({ stage: DEMO_OPPORTUNITY.stage, value_cents: DEMO_OPPORTUNITY.valueCents });
    expect(o.owner).toBeTruthy();
  });

  it("a second run creates nothing new", async () => {
    const before = await one<{ p: number; o: number; g: number; op: number }>(
      sql`select (select count(*)::int from persons) as p, (select count(*)::int from orders) as o, (select count(*)::int from credit_grants) as g, (select count(*)::int from opportunities) as op`,
    );
    await runSeed(h.db, { profile: "demo", env: { APP_ENV: "local" }, clock: NOW, seeds: SEEDS, runJobsAfter: false, log: () => undefined });
    const after = await one<typeof before>(
      sql`select (select count(*)::int from persons) as p, (select count(*)::int from orders) as o, (select count(*)::int from credit_grants) as g, (select count(*)::int from opportunities) as op`,
    );
    expect(after).toEqual(before);
  });
});

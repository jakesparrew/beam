/**
 * finance-P2 numbering under real concurrency (finance edge case 1, decision 35). PGlite has a
 * single connection, so this test runs only against a Neon development branch: set
 * `BEAM_NEON_TESTS=1`, `DATABASE_DRIVER=neon-ws`, `DATABASE_URL` of the branch (migrations
 * applied) and `BEAM_NEON_BRANCH=dev-<name>`. It never runs against `beam_dev` or production.
 * Twenty transactions issue at once; the counter row lock serialises them into twenty distinct,
 * consecutive numbers. The documents stay behind (invoices are never deleted); the branch's TTL
 * removes them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDbHandle, type DbHandle } from "@beam/db";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import { makePerson } from "@beam/db/testing";
import { createCtx } from "@/lib/ctx";
import { issueInvoice } from "./api";
import { lastNumber } from "./service/__tests__/fixtures";

vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const { withFinanceJobStubs } = await import("./service/__tests__/fixtures");
  return withFinanceJobStubs(await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>());
});

const enabled =
  process.env.BEAM_NEON_TESTS === "1" && process.env.DATABASE_DRIVER === "neon-ws" && (process.env.BEAM_NEON_BRANCH ?? "").startsWith("dev-");

describe.skipIf(!enabled)("numbering on a Neon dev branch", () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await createDbHandle("neon-ws");
  }, 60_000);
  afterAll(() => h?.close());

  it("gives 20 parallel issues 20 distinct consecutive numbers", async () => {
    const now = new Date("2099-06-15T10:00:00Z");
    const person = await makePerson(h.db);
    const orders = [];
    for (let i = 0; i < 20; i++) orders.push((await makePaidOrder(h.db, { personId: person.id })).order);
    const before = (await lastNumber(h.db, "invoice", 2099)) ?? 0;

    const results = await Promise.all(
      orders.map((order) =>
        h.db.transaction((tx) => issueInvoice(tx, createCtx({ tx, actor: { kind: "system", jobId: "" }, now }), { orderId: order.id })),
      ),
    );
    const numbers = results.map((r) => (r.status === "issued" ? Number(r.number.slice(-6)) : -1)).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(20);
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => before + i + 1));
    expect(await lastNumber(h.db, "invoice", 2099)).toBe(before + 20);
  }, 120_000);
});

/**
 * ops rule 35a (ops-P3): the prepaid credits outstanding equal credits' `v_credit_liability` for
 * today and credits' `getCreditLiabilityAsOf` for a past date; ops computes nothing itself.
 * Grants and ledger entries come from `@beam/db/testing/credits-factories`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { vCreditLiability } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { makeCreditGrant, makeEntry } from "@beam/db/testing/credits-factories";
import { resetRuntime, staffActor } from "@/lib/testing";
import { getCreditLiabilityAsOf } from "@/modules/credits/api";
import { computeCreditLiability, liabilityCsvRows, liabilityDateFor } from "./liability";
import { getCreditLiability, getCreditLiabilityForPeriod } from "./queries";

let h: DbHandle;
const DAY = 86_400_000;
const now = new Date();
const ago = (d: number) => new Date(now.getTime() - d * DAY);

beforeAll(async () => {
  h = await createTestDb();
  const p = await makePerson(h.db, { isTester: false });
  // 40 days ago: 10 day credits and 5 nights; 10 days ago 4 day credits used; today 50 euro credit.
  const day = await makeCreditGrant(h.db, { personId: p.id, creditKind: "day", units: 10, startsAt: ago(40), unitValueCents: 2_500 });
  await makeEntry(h.db, { grantId: day.id, kind: "consume", quantity: -4, createdAt: ago(10) });
  await makeCreditGrant(h.db, { personId: p.id, creditKind: "night", units: 5, startsAt: ago(40), unitValueCents: 9_000 });
  await makeCreditGrant(h.db, { personId: p.id, creditKind: "euro", units: 5_000 });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const sorted = <T extends { kind: string; vatTreatment: string }>(rows: T[]) => [...rows].sort((a, b) => `${a.kind}${a.vatTreatment}`.localeCompare(`${b.kind}${b.vatTreatment}`));

describe("rule 35a: prepaid credits outstanding", () => {
  it("today equals credits' v_credit_liability", async () => {
    const result = await computeCreditLiability(h.db, { now });
    const view = await h.db.select().from(vCreditLiability);
    expect(result.source).toBe("today");
    expect(sorted(result.rows)).toEqual(
      sorted(
        view.map((v) => ({
          kind: v.creditKind,
          vatTreatment: v.vatTreatment,
          vatRatePct: v.vatRatePct === null ? null : Number(v.vatRatePct),
          remainingUnits: Number(v.remainingUnits),
          remainingValueCents: Number(v.remainingValueCents),
        })),
      ),
    );
    const day = result.rows.find((r) => r.kind === "day")!;
    expect(day).toMatchObject({ remainingUnits: 6, remainingValueCents: 15_000 });
    expect(result.totalValueCents).toBe(result.rows.reduce((a, r) => a + r.remainingValueCents, 0));
  });

  it("a past date equals credits' getCreditLiabilityAsOf for that date", async () => {
    const at = ago(20);
    const result = await computeCreditLiability(h.db, { at, now });
    expect(result.source).toBe("as_of");
    expect(result.asOf).toEqual(at);
    expect(sorted(result.rows)).toEqual(sorted(await getCreditLiabilityAsOf(h.db, at)));
    expect(result.rows.find((r) => r.kind === "day")).toMatchObject({ remainingUnits: 10, remainingValueCents: 25_000 });
    expect(result.rows.find((r) => r.kind === "euro")).toBeUndefined();
  });

  it("a date of today (or later) reads today's view", async () => {
    expect((await computeCreditLiability(h.db, { at: now, now })).source).toBe("today");
    expect((await computeCreditLiability(h.db, { at: new Date(now.getTime() + DAY), now })).source).toBe("today");
  });

  it("the revenue report uses the end of a finished period, else today", async () => {
    const ctx = { tx: h.db, actor: staffActor({ permissions: ["reports.read"] }), now, locale: "en" as const };
    expect(liabilityDateFor(new Date(now.getTime() + DAY), now)).toBeUndefined();
    expect(liabilityDateFor(ago(1), now)).toEqual(new Date(ago(1).getTime() - 1));
    expect((await getCreditLiabilityForPeriod(ctx, { period: "month", at: now })).source).toBe("today");
    const past = await getCreditLiabilityForPeriod(ctx, { period: "day", at: ago(20) });
    expect(past.source).toBe("as_of");
    expect(past.rows.find((r) => r.kind === "day")!.remainingUnits).toBe(10);
  });

  it("getCreditLiability needs reports.read", async () => {
    const base = { tx: h.db, now, locale: "en" as const };
    await expect(getCreditLiability({ ...base, actor: staffActor({ permissions: ["credits.read"] }) })).rejects.toThrow(/forbidden/);
    expect((await getCreditLiability({ ...base, actor: staffActor({ permissions: ["reports.read"] }) })).rows.length).toBeGreaterThan(0);
  });

  it("the CSV rows carry the as-of date and the same figures", async () => {
    const ctx = { tx: h.db, actor: staffActor({ permissions: ["reports.read"] }), now, locale: "en" as const };
    const rows: unknown[][] = [];
    for await (const r of liabilityCsvRows(ctx, {})) rows.push(r);
    const today = await computeCreditLiability(h.db, { now });
    expect(rows).toHaveLength(today.rows.length);
    expect(rows.map((r) => r[5]).reduce((a, b) => (a as number) + (b as number), 0)).toBe(today.totalValueCents);
  });
});

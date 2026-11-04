/**
 * Review finding 6 (ops rules 35a and 41): the liability CSV of a past date holds the figures of
 * the end of that Brussels day, the instant the revenue page shows, not those of its noon.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { periodRange } from "@beam/core/ops";
import { createTestDb, makePerson } from "@beam/db/testing";
import { makeCreditGrant, makeEntry } from "@beam/db/testing/credits-factories";
import { resetRuntime, staffActor } from "@/lib/testing";
import { liabilityCsvRows } from "./liability";
import { getCreditLiabilityForPeriod } from "./queries";
import { brusselsDate } from "./revenue";

let h: DbHandle;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = new Date();
const lastDayNoon = new Date(now.getTime() - 10 * DAY);
const lastDay = periodRange("day", lastDayNoon);
/** 15:00 Brussels on the period's last day: after the noon the CSV used to read. */
const afternoon = new Date(lastDay.from.getTime() + 15 * HOUR);

beforeAll(async () => {
  h = await createTestDb();
  const p = await makePerson(h.db, { isTester: false });
  const day = await makeCreditGrant(h.db, { personId: p.id, creditKind: "day", units: 10, startsAt: new Date(now.getTime() - 40 * DAY), unitValueCents: 2_500 });
  await makeEntry(h.db, { grantId: day.id, kind: "consume", quantity: -4, createdAt: afternoon });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

describe("liability CSV of a past period (review finding 6)", () => {
  it("an entry of the afternoon of the period's last day is in both the page figures and the CSV", async () => {
    const ctx = { tx: h.db, actor: staffActor({ permissions: ["reports.read"] }), now, locale: "en" as const };
    const page = await getCreditLiabilityForPeriod(ctx, { period: "day", at: lastDayNoon });
    expect(page.source).toBe("as_of");
    expect(page.asOf).toEqual(new Date(lastDay.to.getTime() - 1));
    const pageDay = page.rows.find((r) => r.kind === "day")!;
    expect(pageDay).toMatchObject({ remainingUnits: 6, remainingValueCents: 15_000 });

    const rows: unknown[][] = [];
    for await (const r of liabilityCsvRows(ctx, { at: brusselsDate(page.asOf) })) rows.push(r);
    const csvDay = rows.find((r) => r[1] === "day")!;
    expect(csvDay[0]).toBe(brusselsDate(lastDayNoon));
    expect(csvDay[4]).toBe(pageDay.remainingUnits);
    expect(csvDay[5]).toBe(pageDay.remainingValueCents);
  });
});

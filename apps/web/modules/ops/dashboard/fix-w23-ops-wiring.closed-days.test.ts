/**
 * fix-w23-ops-wiring, `closedDaysFrom` (the due date of a card task, rule 22a): the closed days
 * come from booking's `listClosedDays` (`@/modules/booking/api`) for a year from the Brussels
 * date of `at`, so ops reads no `session_exceptions`. Days closed for every template count; an
 * exception for some templates only does not.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { sessionExceptions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { DEFAULT_BUSINESS_HOURS } from "@beam/core/booking";
import { nextBusinessDay } from "@beam/core/ops";
import type * as BookingApi from "@/modules/booking/api";

vi.mock("@/modules/booking/api", async (orig) => {
  const real = await orig<typeof BookingApi>();
  return { ...real, listClosedDays: vi.fn(real.listClosedDays) };
});

const { listClosedDays } = await import("@/modules/booking/api");
const { closedDaysFrom, taskDueAt } = await import("./cards");

let h: DbHandle;
const name = { "nl-BE": "Gesloten", "fr-BE": "Fermé", en: "Closed" };

beforeAll(async () => {
  h = await createTestDb();
  await h.db.insert(sessionExceptions).values([
    { onDate: "2026-12-24", kind: "closed", name },
    { onDate: "2026-12-26", kind: "holiday", name },
    { onDate: "2026-12-28", kind: "closed", name, templateIds: [randomUUID()] },
  ]);
});
afterAll(() => h.close());

describe("closedDaysFrom reads booking's listClosedDays", () => {
  it("asks booking for a year from the Brussels date of at, and keeps only days closed for every template", async () => {
    // 22:30 UTC is 23:30 CET: still 9 December in Brussels.
    const at = new Date("2026-12-09T22:30:00.000Z");
    const days = await closedDaysFrom(h.db, at);
    expect(vi.mocked(listClosedDays)).toHaveBeenCalledWith(h.db, "2026-12-09", "2027-12-11");
    expect(days).toEqual(["2026-12-24", "2026-12-26"]);
  });

  it("a task due date skips the booking closed days", async () => {
    // Wednesday 23 December 2026, 14:00 Brussels: Thursday 24 is closed, Friday 25 is Christmas and Saturday 26 a holiday.
    const at = new Date("2026-12-23T13:00:00.000Z");
    const due = await taskDueAt(h.db, at);
    expect(due).toEqual(nextBusinessDay(at, DEFAULT_BUSINESS_HOURS, ["2026-12-24", "2026-12-26"]));
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(due);
    expect(day > "2026-12-26").toBe(true);
  });
});

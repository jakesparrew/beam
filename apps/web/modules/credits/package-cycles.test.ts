/**
 * credits-P10 (R4) repurchase indicators: `v_package_cycles` and `listPackageCycles` (credits spec
 * section 2 "R4 view"): exhausted and expired purchased packages appear with `closed_at` =
 * `status_changed_at`; open, revoked and non-purchase grants are left out; a later purchase of the
 * same credit kind counts as a repurchase (days in Brussels calendar days, also across the DST
 * change), a different kind, a package bought together and a refunded (revoked) repurchase do not.
 * Also `getGuestUsesLeft` (booking-P8 request): monthly guest uses left on own grants. Every date is
 * pinned (CONVENTIONS 11).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import { makeOrderLine } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant, makeEntry } from "@beam/db/testing/credits-factories";
import type { DbHandle } from "@beam/db";
import { vPackageCycles } from "@beam/db/schema";
import { getViewConfig } from "drizzle-orm/pg-core";

const api = await import("./api");
const { listPackageCycles, getGuestUsesLeft } = api;
const { eq } = await import("@/lib/ctx");

let h: DbHandle;
const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);

type GrantOpts = {
  personId: string;
  kind?: "day" | "night" | "euro";
  status?: "active" | "exhausted" | "expired" | "revoked";
  source?: "purchase" | "manual" | "bonus";
  startsAt: Date;
  closedAt?: Date;
};

async function grant(o: GrantOpts) {
  const source = o.source ?? "purchase";
  const kind = o.kind ?? "day";
  const purchase = source === "purchase" ? { orderLineId: (await makeOrderLine(h.db)).id, lineUnitIndex: 1 } : {};
  return makeCreditGrant(h.db, {
    personId: o.personId,
    creditKind: kind,
    source,
    ...purchase,
    ...(kind === "euro" ? { unitValueCents: 1, vatTreatment: "multi_purpose" as const } : {}),
    units: 10,
    startsAt: o.startsAt,
    expiresAt: new Date(o.startsAt.getTime() + 180 * DAY),
    status: o.status ?? "active",
    statusChangedAt: o.closedAt ?? o.startsAt,
  });
}

const WINDOW = { from: at("2026-01-01T00:00:00Z"), to: at("2027-01-01T00:00:00Z") };

async function cyclesOf(personId: string, window = WINDOW) {
  return (await listPackageCycles(h.db, window)).filter((c) => c.personId === personId);
}

beforeAll(async () => {
  h = await createTestDb();
});

afterAll(async () => {
  await h?.close();
});

describe("v_package_cycles", () => {
  it("exhausted and expired purchased packages appear; open, revoked and non-purchase grants are excluded", async () => {
    const personId = (await makePerson(h.db)).id;
    const exhausted = await grant({ personId, status: "exhausted", startsAt: at("2026-02-01T09:00:00Z"), closedAt: at("2026-04-10T15:00:00Z") });
    const expired = await grant({ personId, kind: "night", status: "expired", startsAt: at("2026-03-01T09:00:00Z"), closedAt: at("2026-08-28T22:00:00Z") });
    await grant({ personId, status: "active", startsAt: at("2026-01-15T09:00:00Z") });
    await grant({ personId, kind: "night", status: "revoked", startsAt: at("2026-02-20T09:00:00Z"), closedAt: at("2026-04-01T09:00:00Z") });
    await grant({ personId, source: "manual", status: "exhausted", startsAt: at("2026-02-10T09:00:00Z"), closedAt: at("2026-05-01T09:00:00Z") });

    const rows = await cyclesOf(personId);
    expect(rows.map((r) => r.grantId)).toEqual([exhausted.id, expired.id]);
    expect(rows[0]).toEqual({ personId, grantId: exhausted.id, closedAt: at("2026-04-10T15:00:00Z"), repurchased: false, daysToRepurchase: null });
    expect(rows[1]!.closedAt).toEqual(at("2026-08-28T22:00:00Z"));

    const [viewRow] = await h.db.select().from(vPackageCycles).where(eq(vPackageCycles.grantId, exhausted.id));
    expect(viewRow).toMatchObject({ personId, productId: exhausted.productId, creditKind: "day", nextPurchaseAt: null, repurchased: false });
    expect(Object.keys(viewRow!).sort()).toEqual(Object.keys(getViewConfig(vPackageCycles).selectedFields).sort());
  });

  it("the window is [from, to) on closed_at; an inverted window returns nothing", async () => {
    const personId = (await makePerson(h.db)).id;
    const g = await grant({ personId, status: "exhausted", startsAt: at("2026-01-05T09:00:00Z"), closedAt: at("2026-06-01T00:00:00Z") });
    expect((await cyclesOf(personId, { from: at("2026-06-01T00:00:00Z"), to: at("2026-06-02T00:00:00Z") })).map((r) => r.grantId)).toEqual([g.id]);
    expect(await cyclesOf(personId, { from: at("2026-05-01T00:00:00Z"), to: at("2026-06-01T00:00:00Z") })).toEqual([]);
    expect(await listPackageCycles(h.db, { from: at("2026-07-01T00:00:00Z"), to: at("2026-06-01T00:00:00Z") })).toEqual([]);
    await expect(listPackageCycles(h.db, { from: new Date("nope"), to: WINDOW.to })).rejects.toThrow(/invalid_window/);
  });

  it("a later purchase of the same kind is a repurchase; a different kind is not", async () => {
    const personId = (await makePerson(h.db)).id;
    const day = await grant({ personId, status: "exhausted", startsAt: at("2026-02-01T09:00:00Z"), closedAt: at("2026-04-10T15:00:00Z") });
    const night = await grant({ personId, kind: "night", status: "exhausted", startsAt: at("2026-02-01T09:00:00Z"), closedAt: at("2026-04-12T15:00:00Z") });
    // the next day package (still open) bought 5 Brussels days after the first one closed
    const next = await grant({ personId, status: "active", startsAt: at("2026-04-15T08:00:00Z") });
    // a manual night grant is no repurchase of the night package
    await grant({ personId, kind: "night", source: "manual", startsAt: at("2026-04-20T08:00:00Z") });

    const rows = await cyclesOf(personId);
    const byId = new Map(rows.map((r) => [r.grantId, r]));
    expect(byId.get(day.id)).toMatchObject({ repurchased: true, daysToRepurchase: 5 });
    expect(byId.get(night.id)).toMatchObject({ repurchased: false, daysToRepurchase: null });
    expect(byId.has(next.id)).toBe(false);
    const [viewRow] = await h.db.select().from(vPackageCycles).where(eq(vPackageCycles.grantId, day.id));
    expect(viewRow!.nextPurchaseAt).toEqual(next.startsAt);
  });

  it("the earliest later purchase wins; a package bought together or revoked is no repurchase; days are Brussels days", async () => {
    const personId = (await makePerson(h.db)).id;
    // closed 23:30 Brussels on 28 March (CET); repurchased 00:30 Brussels on 30 March (CEST): two
    // Brussels calendar days although less than 48 hours passed.
    const first = await grant({ personId, status: "exhausted", startsAt: at("2026-01-10T09:00:00Z"), closedAt: at("2026-03-28T22:30:00Z") });
    const sibling = await grant({ personId, status: "expired", startsAt: at("2026-01-10T09:00:00Z"), closedAt: at("2026-07-09T21:59:59Z") });
    await grant({ personId, status: "revoked", startsAt: at("2026-02-01T09:00:00Z"), closedAt: at("2026-02-03T09:00:00Z") });
    const later = await grant({ personId, status: "active", startsAt: at("2026-03-29T22:30:00Z") });
    await grant({ personId, status: "active", startsAt: at("2026-05-01T08:00:00Z") });

    const byId = new Map((await cyclesOf(personId)).map((r) => [r.grantId, r]));
    expect(byId.get(first.id)).toMatchObject({ repurchased: true, daysToRepurchase: 2 });
    // the next package was bought before the sibling closed: 0 days, still a repurchase
    expect(byId.get(sibling.id)).toMatchObject({ repurchased: true, daysToRepurchase: 0 });
    const [viewRow] = await h.db.select().from(vPackageCycles).where(eq(vPackageCycles.grantId, first.id));
    expect(viewRow!.nextPurchaseAt).toEqual(later.startsAt);
  });

  it("only purchased grants count as a repurchase", async () => {
    const personId = (await makePerson(h.db)).id;
    const g = await grant({ personId, status: "exhausted", startsAt: at("2026-01-10T09:00:00Z"), closedAt: at("2026-03-01T09:00:00Z") });
    await grant({ personId, source: "bonus", startsAt: at("2026-03-05T09:00:00Z") });
    expect((await cyclesOf(personId)).find((r) => r.grantId === g.id)).toMatchObject({ repurchased: false, daysToRepurchase: null });
  });
});

describe("getGuestUsesLeft (booking-P8 request)", () => {
  const AT = at("2026-03-15T10:00:00Z");

  async function guestUse(grantId: string, owner: string, createdAt: Date) {
    const guest = (await makePerson(h.db)).id;
    return makeEntry(h.db, { grantId, personId: owner, kind: "consume", quantity: -1, beneficiaryPersonId: guest, refType: "booking", refId: randomUUID(), createdAt });
  }

  it("sums the monthly limit minus this Brussels month's unreleased guest uses over own valid grants", async () => {
    const owner = (await makePerson(h.db)).id;
    const sharing = (max: number) => ({ mode: "guests" as const, max_guest_uses_per_month: max, allowed_person_ids: [] });
    const a = await makeCreditGrant(h.db, { personId: owner, creditKind: "day", units: 10, startsAt: at("2026-01-01T09:00:00Z"), expiresAt: at("2026-12-31T22:59:59Z"), sharing: sharing(2) });
    const b = await makeCreditGrant(h.db, { personId: owner, creditKind: "day", units: 10, startsAt: at("2026-02-01T09:00:00Z"), expiresAt: at("2026-12-31T22:59:59Z"), sharing: sharing(3) });
    // not counted: mode none, other kind, expired before `at`, not started at `at`
    await makeCreditGrant(h.db, { personId: owner, creditKind: "day", units: 10, startsAt: at("2026-01-01T09:00:00Z"), expiresAt: at("2026-12-31T22:59:59Z") });
    await makeCreditGrant(h.db, { personId: owner, creditKind: "night", units: 4, startsAt: at("2026-01-01T09:00:00Z"), expiresAt: at("2026-12-31T22:59:59Z"), sharing: sharing(4) });
    await makeCreditGrant(h.db, { personId: owner, creditKind: "day", units: 10, startsAt: at("2025-09-01T09:00:00Z"), expiresAt: at("2026-03-01T22:59:59Z"), sharing: sharing(5) });
    await makeCreditGrant(h.db, { personId: owner, creditKind: "day", units: 10, startsAt: at("2026-04-01T09:00:00Z"), expiresAt: at("2026-12-31T22:59:59Z"), sharing: sharing(5) });

    expect(await getGuestUsesLeft(h.db, { personId: owner, kind: "day", at: AT })).toBe(5);

    await guestUse(a.id, owner, at("2026-03-02T10:00:00Z"));
    await guestUse(a.id, owner, at("2026-03-10T10:00:00Z"));
    await guestUse(a.id, owner, at("2026-03-12T10:00:00Z")); // over the limit: never below 0
    // last month (28 Feb 23:30 Brussels) does not count; 1 March 00:30 Brussels does
    await guestUse(b.id, owner, at("2026-02-28T22:30:00Z"));
    await guestUse(b.id, owner, at("2026-02-28T23:30:00Z"));
    const released = await guestUse(b.id, owner, at("2026-03-05T10:00:00Z"));
    await makeEntry(h.db, { grantId: b.id, personId: owner, kind: "release", quantity: 1, reversesEntryId: released.id, beneficiaryPersonId: released.beneficiaryPersonId, refType: "booking", refId: released.refId, createdAt: at("2026-03-06T10:00:00Z") });
    // own use is no guest use
    await makeEntry(h.db, { grantId: b.id, personId: owner, kind: "consume", quantity: -1, beneficiaryPersonId: owner, refType: "booking", refId: randomUUID(), createdAt: at("2026-03-07T10:00:00Z") });

    expect(await getGuestUsesLeft(h.db, { personId: owner, kind: "day", at: AT })).toBe(0 + 2);
    expect(await getGuestUsesLeft(h.db, { personId: owner, kind: "night", at: AT })).toBe(4);
    expect(await getGuestUsesLeft(h.db, { personId: (await makePerson(h.db)).id, kind: "day", at: AT })).toBe(0);
  });
});

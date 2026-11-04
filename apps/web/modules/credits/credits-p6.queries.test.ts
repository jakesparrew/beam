/**
 * credits-P6 staff queries and the desk badge text (credits spec sections 4 "Queries" and 5):
 * the grants list with filters and keyset paging, the grant detail with running balance and
 * guests, the membership list filters and detail, the tiles, and the one-line desk summary.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson, makeSession } from "@beam/db/testing";
import { makeCreditGrant, makeEntry, makeMembership } from "@beam/db/testing/credits-factories";
import type { DbHandle } from "@beam/db";
import { bookings } from "@beam/db/schema";
import { attendanceOf, creditsLabels, getCreditsTiles, getGrant, getMembership, listGrants, listMemberships } from "./queries";
import { deskCreditsParts } from "./ui/desk-credits-badge";

let h: DbHandle;
const DAY = 86_400_000;

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  await h.close();
});

describe("listGrants", () => {
  it("filters by kind, status, person, search and expiry window and pages with a cursor", async () => {
    const person = await makePerson(h.db, { firstName: "Zelda", lastName: "Quintens", email: `zelda-${randomUUID().slice(0, 6)}@example.com` });
    const soon = await makeCreditGrant(h.db, { personId: person.id, units: 3, creditKind: "night", expiresAt: new Date(Date.now() + 10 * DAY) });
    await makeCreditGrant(h.db, { personId: person.id, units: 2, creditKind: "day", expiresAt: new Date(Date.now() + 200 * DAY) });
    await makeCreditGrant(h.db, { personId: person.id, units: 1, creditKind: "day", expiresAt: new Date(Date.now() + 300 * DAY) });

    const mine = await listGrants(h.db, { personId: person.id });
    expect(mine.rows).toHaveLength(3);
    expect(mine.rows.every((r) => r.personName === "Zelda Quintens")).toBe(true);
    expect((await listGrants(h.db, { personId: person.id, kind: "night" })).rows.map((r) => r.grantId)).toEqual([soon.id]);
    expect((await listGrants(h.db, { personId: person.id, expiringWithinDays: 30 })).rows.map((r) => r.grantId)).toEqual([soon.id]);
    expect((await listGrants(h.db, { q: "quintens" })).rows).toHaveLength(3);
    expect((await listGrants(h.db, { personId: person.id, status: "revoked" })).rows).toHaveLength(0);

    const first = await listGrants(h.db, { personId: person.id, limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await listGrants(h.db, { personId: person.id, limit: 2, cursor: first.nextCursor });
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.rows, ...second.rows].map((r) => r.grantId)).size).toBe(3);
  });
});

describe("getGrant", () => {
  it("returns the ledger with a running balance, guests with attendance and this month's guest uses", async () => {
    const grant = await makeCreditGrant(h.db, { units: 5, sharing: { mode: "guests", max_guest_uses_per_month: 2, allowed_person_ids: [] } });
    const guest = await makePerson(h.db, { firstName: "Gita", lastName: "Gast" });
    const session = await makeSession(h.db, { startsAt: new Date(Date.now() + 3 * DAY) });
    const [booking] = await h.db
      .insert(bookings)
      .values({ sessionId: session.id, personId: guest.id, status: "confirmed", paidWith: "credit", source: "admin" })
      .returning();
    await makeEntry(h.db, { grantId: grant.id, kind: "consume", quantity: -1, beneficiaryPersonId: guest.id, refType: "booking", refId: booking!.id });
    await makeEntry(h.db, { grantId: grant.id, kind: "adjust", quantity: -1, reason: "Correction" });

    const d = await getGrant(h.db, grant.id);
    expect(d.balance).toMatchObject({ remainingUnits: 3, baseUnits: 5 });
    expect(d.entries.map((e) => [e.kind, e.runningBalance])).toEqual([
      ["grant", 5],
      ["consume", 4],
      ["adjust", 3],
    ]);
    const use = d.entries[1]!;
    expect(use).toMatchObject({ beneficiaryName: "Gita Gast", bookingId: booking!.id, attendance: "upcoming" });
    expect(d.guests).toMatchObject([{ personId: guest.id, name: "Gita Gast", uses: 1 }]);
    expect(d.guestUsesThisMonth).toBe(1);
    await expect(getGrant(h.db, randomUUID())).rejects.toMatchObject({ code: "not_found" });
    await expect(getGrant(h.db, "nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("maps booking statuses to attendance", () => {
    const past = new Date(Date.now() - DAY);
    const future = new Date(Date.now() + DAY);
    expect(attendanceOf("confirmed", future, new Date())).toBe("upcoming");
    expect(attendanceOf("no_show", past, new Date())).toBe("no_show");
    expect(attendanceOf("late_cancelled", past, new Date())).toBe("late_cancelled");
    expect(attendanceOf(null, past, new Date())).toBeNull();
  });
});

describe("memberships", () => {
  it("lists by status and renewal window and returns the detail with periods and current grants", async () => {
    const pastDue = await makeMembership(h.db, { status: "past_due", dunningAttempt: 1, pastDueSinceAt: new Date() });
    const renewing = await makeMembership(h.db, { currentPeriodEndAt: new Date(Date.now() + 5 * DAY) });
    expect((await listMemberships(h.db, { status: "past_due" })).rows.map((r) => r.membershipId)).toContain(pastDue.id);
    expect((await listMemberships(h.db, { status: "past_due" })).rows.map((r) => r.membershipId)).not.toContain(renewing.id);
    expect((await listMemberships(h.db, { renewingWithinDays: 30 })).rows.map((r) => r.membershipId)).toContain(renewing.id);

    await makeCreditGrant(h.db, { personId: renewing.personId, source: "membership", membershipId: renewing.id, units: 4, startsAt: renewing.currentPeriodStartAt, expiresAt: renewing.currentPeriodEndAt });
    const d = await getMembership(h.db, renewing.id);
    expect(d.membership.id).toBe(renewing.id);
    expect(d.currentGrants).toMatchObject([{ kind: "day", remainingUnits: 4 }]);
    await expect(getMembership(h.db, randomUUID())).rejects.toMatchObject({ code: "not_found" });
  });

  it("counts the tiles", async () => {
    const t = await getCreditsTiles(h.db);
    expect(t.activeGrants).toBeGreaterThanOrEqual(1);
    expect(t.pastDueMemberships).toBeGreaterThanOrEqual(1);
    expect(t.membershipsRenewingIn30Days).toBeGreaterThanOrEqual(1);
    expect(t.outstanding.map((o) => o.kind)).toEqual(["day", "night", "euro"]);
  });
});

describe("labels and the desk line", () => {
  it("keys client labels by their catalogue path in every locale", () => {
    for (const locale of ["nl-BE", "fr-BE", "en"] as const) {
      const l = creditsLabels(locale, ["admin.common", "errors"]);
      expect(l["admin.common.cancel"]).toBeTruthy();
      expect(l["errors.stale_version"]).toBeTruthy();
    }
  });

  it("writes one line with the units per kind, the membership and past due", () => {
    const end = new Date("2026-12-31T12:00:00Z");
    const line = deskCreditsParts(
      { byKind: [{ kind: "day", remainingUnits: 4 }, { kind: "night", remainingUnits: 1 }, { kind: "euro", remainingUnits: 0 }], membership: { status: "past_due", periodEndAt: end } },
      "en",
    );
    expect(line.text).toMatch(/^Day: 4 · Night: 1 · Member until .*2026$/);
    expect(line.pastDue).toBe(true);
    expect(deskCreditsParts({ byKind: [], membership: null }, "nl-BE")).toEqual({ text: "Geen pakketten", pastDue: false });
  });
});

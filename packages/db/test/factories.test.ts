import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "../src/client";
import { creditEntries } from "../src/schema/credits";
import { priceVersions } from "../src/schema/commerce";
import {
  createTestDb,
  makeGrant,
  makePerson,
  makeProduct,
  makeSession,
  makeUser,
} from "../src/testing";

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
});
afterAll(() => h.close());

describe("factories", () => {
  it("makePerson gives a unique @example.com tester in nl-BE", async () => {
    const a = await makePerson(h.db);
    const b = await makePerson(h.db, { locale: "fr-BE" });
    expect(a.email).toMatch(/@example\.com$/);
    expect(a.email).not.toBe(b.email);
    expect(a).toMatchObject({ locale: "nl-BE", isTester: true });
    expect(b.locale).toBe("fr-BE");
  });

  it("makeUser builds a staff user with its role, a customer with its person, and a partner", async () => {
    const staff = await makeUser(h.db);
    expect(staff).toMatchObject({
      audience: "staff",
      roleKey: "technical_admin",
      status: "active",
    });
    expect(staff.mfaEnrolledAt).toBeInstanceOf(Date);
    const owner = await makeUser(h.db, { roleKey: "owner" });
    expect(owner.roleKey).toBe("owner");
    const customer = await makeUser(h.db, { audience: "customer" });
    expect(customer.roleKey).toBeNull();
    expect(customer.personId).toBeTruthy();
    const partner = await makeUser(h.db, { roleKey: "external_partner" });
    expect(partner.personId).toBeTruthy();
  });

  it("makeProduct satisfies the product checks for every kind and can add a price", async () => {
    for (const kind of [
      "session",
      "night",
      "package",
      "membership",
      "ticket",
      "item",
      "voucher",
    ] as const) {
      const p = await makeProduct(h.db, { kind });
      expect(p.kind).toBe(kind);
    }
    const priced = await makeProduct(h.db, { priceCents: 9900 });
    const prices = await h.db
      .select()
      .from(priceVersions)
      .where(eq(priceVersions.productId, priced.id));
    expect(prices).toMatchObject([
      { version: 1, audience: "public", amountCents: 9900 },
    ]);
  });

  it("makeSession builds day, night and event sessions", async () => {
    const day = await makeSession(h.db);
    expect(day).toMatchObject({
      kind: "day",
      status: "open",
      capacitySeats: 10,
      creditKind: "day",
      creditCost: 1,
    });
    expect(day.endsAt.getTime()).toBeGreaterThan(day.startsAt.getTime());
    const night = await makeSession(h.db, { kind: "night" });
    expect(night).toMatchObject({ capacityBeds: 6, creditKind: "night" });
    const event = await makeSession(h.db, { kind: "event", creditKind: null });
    expect(event.kind).toBe("event");
  });

  it("makeGrant writes the grant and its ledger entry", async () => {
    const person = await makePerson(h.db, { locale: "fr-BE" });
    const grant = await makeGrant(h.db, {
      personId: person.id,
      creditKind: "day",
      units: 5,
    });
    expect(grant).toMatchObject({
      personId: person.id,
      creditKind: "day",
      unitsGranted: 5,
      status: "active",
    });
    const entries = await h.db
      .select()
      .from(creditEntries)
      .where(eq(creditEntries.grantId, grant.id));
    expect(entries).toMatchObject([
      { kind: "grant", quantity: 5, personId: person.id },
    ]);
    const euro = await makeGrant(h.db, { creditKind: "euro", units: 2500 });
    expect(euro.unitValueCents).toBe(1);
    const total = await h.db.execute<{ n: number }>(
      sql`select count(*)::int as n from credit_grants`,
    );
    expect((total as { rows: { n: number }[] }).rows[0]?.n).toBe(2);
  });
});

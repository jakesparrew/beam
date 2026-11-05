/**
 * booking-P9 (R3): who may assign and unassign hold seats (booking spec 4.2 and 7). Staff with
 * `bookings.write` on every hold; `partner.own` only on the holds of the user's own partner
 * company (an `external_partner` stays scoped even when granted more); nobody else. Every staff
 * write is audited under its action name.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, capacityHolds, companies, roles } from "@beam/db/schema";
import { createTestDb, ensureRole, makePerson, makeUser } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.11" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./partner");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { clearSchedule } = await import("./booking-p2.fixtures");
const { DAY, openSession, setBookingRules } = await import("../server/booking-p3a.fixtures");

const unauthorized = { ok: false, error: { code: "unauthorized" } };
const forbidden = { ok: false, error: { code: "forbidden" } };
const notFound = { ok: false, error: { code: "not_found" } };
let h: DbHandle;
let companyA: string;
let companyB: string;

async function makeCompany(name: string): Promise<string> {
  const [row] = await h.db.insert(companies).values({ name, isPartner: true }).returning({ id: companies.id });
  return row!.id;
}

/** Signs in a staff-audience user of `roleKey` whose role holds exactly `permissions`. */
async function signIn(roleKey: "external_partner" | "reception", permissions: string[], partnerCompanyId: string | null = null) {
  await ensureRole(h.db, roleKey);
  await h.db.update(roles).set({ permissions }).where(eq(roles.key, roleKey));
  const person = await makePerson(h.db, { partnerCompanyId });
  const user = await makeUser(h.db, { roleKey, personId: person.id });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(SESSION_COOKIE, token);
  return user;
}

async function asCustomer() {
  const user = await makeUser(h.db, { audience: "customer" });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
}

async function holds() {
  const session = await openSession(h.db, { kind: "event", eventCategory: "lecture", creditKind: null, creditCost: 0, capacitySeats: 20, startsAt: new Date(Date.now() + 3.25 * DAY) });
  const [a] = await h.db.insert(capacityHolds).values({ sessionId: session.id, kind: "partner", quantity: 5, companyId: companyA }).returning();
  const [b] = await h.db.insert(capacityHolds).values({ sessionId: session.id, kind: "partner", quantity: 5, companyId: companyB }).returning();
  return { a: a!, b: b! };
}

const seat = (holdId: string) => ({ holdId, firstName: "Ann", lastName: "Example" });
const auditOf = (action: string, entityId: string) => h.db.select().from(auditLog).where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  companyA = await makeCompany("Partner A BV");
  companyB = await makeCompany("Partner B BV");
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await clearSchedule(h.db);
  await setBookingRules(h.db);
});

describe("booking actions, area partner: permissions (booking spec 4.2, 7)", () => {
  it("refuses anonymous visitors and customers (unauthorized)", async () => {
    const { a } = await holds();
    expect(await actions.assignHoldSeat(seat(a.id))).toMatchObject(unauthorized);
    expect(await actions.unassignHoldSeat({ bookingId: a.id })).toMatchObject(unauthorized);
    await asCustomer();
    expect(await actions.assignHoldSeat(seat(a.id))).toMatchObject(unauthorized);
    expect(await actions.unassignHoldSeat({ bookingId: a.id })).toMatchObject(unauthorized);
  });

  it("refuses staff with neither bookings.write nor partner.own (forbidden)", async () => {
    const { a } = await holds();
    await signIn("reception", ["bookings.read"]);
    expect(await actions.assignHoldSeat(seat(a.id))).toMatchObject(forbidden);
    expect(await actions.unassignHoldSeat({ bookingId: a.id })).toMatchObject(forbidden);
  });

  it("refuses a partner whose person is not linked to a partner company (forbidden)", async () => {
    const { a } = await holds();
    await signIn("external_partner", ["partner.own"], null);
    expect(await actions.assignHoldSeat(seat(a.id))).toMatchObject(forbidden);
  });

  it("lets an external partner assign and unassign on their own company's holds only, audited", async () => {
    const { a, b } = await holds();
    await signIn("external_partner", ["partner.own"], companyA);
    expect(await actions.assignHoldSeat(seat(b.id))).toMatchObject(notFound);
    const res = await actions.assignHoldSeat(seat(a.id));
    expect(res).toMatchObject({ ok: true });
    const bookingId = res.ok ? res.data.bookingId : "";
    expect(await auditOf("booking.assign_hold_seat", bookingId)).toHaveLength(1);
    expect(await actions.unassignHoldSeat({ bookingId })).toMatchObject({ ok: true });
    expect(await auditOf("booking.unassign_hold_seat", bookingId)).toHaveLength(1);
  });

  it("keeps an external partner scoped even when the role was granted bookings.write", async () => {
    const { a, b } = await holds();
    await signIn("external_partner", ["partner.own", "bookings.write"], companyA);
    expect(await actions.assignHoldSeat(seat(b.id))).toMatchObject(notFound);
    expect(await actions.assignHoldSeat(seat(a.id))).toMatchObject({ ok: true });
  });

  it("scopes a staff member who holds partner.own without bookings.write to their company", async () => {
    const { a, b } = await holds();
    await signIn("reception", ["partner.own"], companyB);
    expect(await actions.assignHoldSeat(seat(a.id))).toMatchObject(notFound);
    expect(await actions.assignHoldSeat(seat(b.id))).toMatchObject({ ok: true });
  });

  it("lets staff with bookings.write assign and unassign on every company's hold, audited", async () => {
    const { a, b } = await holds();
    await signIn("reception", ["bookings.write"]);
    const ra = await actions.assignHoldSeat(seat(a.id));
    const rb = await actions.assignHoldSeat(seat(b.id));
    expect(ra).toMatchObject({ ok: true });
    expect(rb).toMatchObject({ ok: true });
    const bookingId = rb.ok ? rb.data.bookingId : "";
    const [audit] = await auditOf("booking.assign_hold_seat", bookingId);
    expect(audit).toMatchObject({ entityType: "booking" });
    expect(await actions.unassignHoldSeat({ bookingId })).toMatchObject({ ok: true });
  });

  it("validates the input before anything runs", async () => {
    await signIn("reception", ["bookings.write"]);
    expect(await actions.assignHoldSeat({ holdId: "not-a-uuid", firstName: "Ann", lastName: "Example" })).toMatchObject({ ok: false, error: { code: "validation" } });
    const { a } = await holds();
    expect(await actions.assignHoldSeat({ holdId: a.id, firstName: " ", lastName: "Example" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.assignHoldSeat({ ...seat(a.id), email: "not-an-email" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.assignHoldSeat({ ...seat(a.id), email: "" })).toMatchObject({ ok: true });
  });
});

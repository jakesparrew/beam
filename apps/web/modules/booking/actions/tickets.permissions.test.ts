import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, ticketTypes } from "@beam/db/schema";
import { createTestDb, makeProduct, makeUser } from "@beam/db/testing";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.10" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/lib/flags", () => ({ flag: vi.fn(), clearFlagCache: vi.fn() }));

const actions = await import("./tickets");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { flag } = await import("@/lib/flags");
const { resetRuntime } = await import("@/lib/testing");
const { staffSession } = await import("./booking-p2.fixtures");
const { DAY, openSession } = await import("../server/booking-p3a.fixtures");

const FULL = { "nl-BE": "Standaard", "fr-BE": "Standard", en: "Standard" };
const forbidden = { ok: false, error: { code: "forbidden" } };
const unauthorized = { ok: false, error: { code: "unauthorized" } };
let h: DbHandle;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  jar.clear();
  vi.mocked(flag).mockReset().mockResolvedValue(true);
});

async function asCustomer() {
  const user = await makeUser(h.db, { audience: "customer" });
  const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
  jar.set(SESSION_COOKIE, token);
}

async function setup() {
  const session = await openSession(h.db, { kind: "event", eventCategory: "concert", creditKind: null, creditCost: 0, capacitySeats: 20, startsAt: new Date(Date.now() + 15.25 * DAY) });
  const product = await makeProduct(h.db, { kind: "ticket", priceCents: 2000 });
  return { session, input: { sessionId: session.id, productId: product.id, name: FULL, maxPerBooking: 4, sortOrder: 0 } };
}

describe("booking actions, area tickets: permissions (booking spec 4.2, 7)", () => {
  it("upsertTicketType needs a staff user with bookings.override and is audited", async () => {
    const { input } = await setup();
    expect(await actions.upsertTicketType(input)).toMatchObject(unauthorized);
    await asCustomer();
    expect(await actions.upsertTicketType(input)).toMatchObject(unauthorized);
    // customer_service and reception (bookings.read/write) do not edit events (section 7).
    await staffSession(h.db, jar, ["bookings.read", "bookings.write", "waitlist.manage"]);
    expect(await actions.upsertTicketType(input)).toMatchObject(forbidden);
    await staffSession(h.db, jar, ["bookings.read", "bookings.write", "bookings.override"]);
    const res = await actions.upsertTicketType(input);
    expect(res).toMatchObject({ ok: true });
    const id = res.ok ? res.data.id : "";
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "booking.upsert_ticket_type")));
    expect(audit).toMatchObject({ entityType: "ticket_type" });
  });

  it("archiveTicketType needs bookings.override, is audited and idempotent", async () => {
    const { input } = await setup();
    await staffSession(h.db, jar, ["bookings.override"]);
    const created = await actions.upsertTicketType(input);
    const id = created.ok ? created.data.id : "";
    jar.clear();
    expect(await actions.archiveTicketType({ id })).toMatchObject(unauthorized);
    await asCustomer();
    expect(await actions.archiveTicketType({ id })).toMatchObject(unauthorized);
    await staffSession(h.db, jar, ["bookings.read", "bookings.write"]);
    expect(await actions.archiveTicketType({ id })).toMatchObject(forbidden);
    await staffSession(h.db, jar, ["bookings.override"]);
    expect(await actions.archiveTicketType({ id })).toEqual({ ok: true, data: { id } });
    expect(await actions.archiveTicketType({ id })).toEqual({ ok: true, data: { id } });
    expect((await h.db.select().from(ticketTypes).where(eq(ticketTypes.id, id)))[0]!.isActive).toBe(false);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "booking.archive_ticket_type")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0]).toMatchObject({ entityType: "ticket_type" });
  });

  it("an owner (*) may edit ticket types; the flag still gates them", async () => {
    const { input } = await setup();
    await staffSession(h.db, jar, ["*"]);
    expect(await actions.upsertTicketType(input)).toMatchObject({ ok: true });
    vi.mocked(flag).mockResolvedValue(false);
    expect(await actions.upsertTicketType(input)).toMatchObject(forbidden);
  });
});

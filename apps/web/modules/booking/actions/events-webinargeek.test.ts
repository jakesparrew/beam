/**
 * Owner requirements 4 and 5: events and WebinarGeek webinars. Price typed on the form (own ticket
 * product, 0 = free), end time, WebinarGeek fields, artwork and materials, the portal access, the
 * CSV rows and the `bookings.register_webinargeek` job (run twice, WebinarGeek fake).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { bookings, products, sessions } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { brusselsTime } from "@beam/core/booking";
import { createWebinarGeekFake } from "@beam/integrations/webinargeek";

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

process.env.AUTH_SECRET ??= "test-secret-for-signed-file-links-0123456789";
const actions = await import("./sessions");
const media = await import("./event-media");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime, runJobTwice } = await import("@/lib/testing");
const { getProductPrice } = await import("@/modules/commerce/api");
const { getEventAccess, listEventRegistrations } = await import("../queries/event-registrations");
const { setWebinarGeekClient } = await import("../jobs/webinargeek");
const { FULL_NAME, addBooking, clearSchedule, staffSession } = await import("./booking-p2.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  setWebinarGeekClient(undefined);
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await clearSchedule(h.db);
  await staffSession(h.db, jar, ["bookings.read", "bookings.write", "bookings.override"]);
});

const reload = async (id: string) => (await h.db.select().from(sessions).where(eq(sessions.id, id)))[0]!;
const webinar = {
  kind: "event" as const,
  eventCategory: "webinar" as const,
  title: FULL_NAME,
  startsAt: "2027-05-04T19:00",
  endsAt: "2027-05-04T20:00",
  capacitySeats: 100,
  creditCost: 0,
  creditKind: null,
};

async function created(input: Parameters<typeof actions.createSession>[0]) {
  const res = await actions.createSession(input);
  if (!res.ok) throw new Error(JSON.stringify(res.error));
  return reload(res.data.sessionId);
}

describe("createSession / updateSession for events and webinars", () => {
  it("a priced webinar gets its own active ticket product; the end time and WebinarGeek fields are kept", async () => {
    const s = await created({ ...webinar, priceCents: 2500, webinarGeekUrl: "https://beam.webinargeek.com/ademwerk", webinarGeekBroadcastId: "123456" });
    expect([brusselsTime(s.startsAt), brusselsTime(s.endsAt)]).toEqual(["19:00", "20:00"]);
    expect(s).toMatchObject({ webinarGeekUrl: "https://beam.webinargeek.com/ademwerk", webinarGeekBroadcastId: "123456" });
    const [p] = await h.db.select().from(products).where(eq(products.id, s.productId!));
    expect(p).toMatchObject({ kind: "ticket", isActive: true });
    expect(p!.sku).toMatch(/^EVT-[0-9A-F]{28}$/);
    expect((await getProductPrice(h.db, s.productId!, "public"))?.amountCents).toBe(2500);

    // A new price re-prices the same product; 0 makes the webinar free (no product).
    const r1 = await actions.updateSession({ id: s.id, expectedUpdatedAt: s.updatedAt.toISOString(), priceCents: 3000 });
    expect(r1).toMatchObject({ ok: true });
    const s1 = await reload(s.id);
    expect(s1.productId).toBe(s.productId);
    expect((await getProductPrice(h.db, s.productId!, "public"))?.amountCents).toBe(3000);
    expect(await actions.updateSession({ id: s.id, expectedUpdatedAt: s1.updatedAt.toISOString(), priceCents: 0, webinarGeekBroadcastId: null })).toMatchObject({ ok: true });
    expect(await reload(s.id)).toMatchObject({ productId: null, webinarGeekBroadcastId: null, webinarGeekUrl: "https://beam.webinargeek.com/ademwerk" });
  });

  it("a free event has no product; an end before the start is refused", async () => {
    const s = await created({ ...webinar, eventCategory: "lecture", priceCents: 0 });
    expect(s.productId).toBeNull();
    expect(await actions.createSession({ ...webinar, endsAt: "2027-05-04T18:00" })).toMatchObject({ ok: false, error: { code: "validation", fields: { endsAt: "after_start" } } });
    expect(await actions.createSession({ ...webinar, webinarGeekUrl: "http://insecure.example.com" })).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("artwork, materials and portal access", () => {
  it("stores the artwork and materials; booked people get the WebinarGeek link, and the materials once released", async () => {
    const s = await created({ ...webinar, webinarGeekUrl: "https://beam.webinargeek.com/ademwerk" });
    const form = (file: File) => {
      const fd = new FormData();
      fd.set("sessionId", s.id);
      fd.set("file", file);
      return fd;
    };
    const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "poster.png", { type: "image/png" });
    expect(await media.uploadSessionImage(form(png))).toMatchObject({ ok: true });
    expect(await media.uploadSessionImage(form(new File(["x"], "notes.txt", { type: "text/plain" })))).toMatchObject({ ok: false, error: { code: "validation" } });
    const added = await media.addSessionMaterial(form(new File(["%PDF-1.4"], "slides.pdf", { type: "application/pdf" })));
    if (!added.ok) throw new Error(JSON.stringify(added.error));
    const row = await reload(s.id);
    expect(row.imageFileId).not.toBeNull();
    expect(row.materialFileIds).toEqual([added.data.fileId]);

    const booked = await addBooking(h.db, s.id);
    const cancelled = await addBooking(h.db, s.id, { status: "cancelled" });
    expect(await getEventAccess(h.db, booked.id)).toEqual({ joinUrl: "https://beam.webinargeek.com/ademwerk", materials: [] });
    expect(await getEventAccess(h.db, cancelled.id)).toEqual({ joinUrl: null, materials: [] });

    expect(await media.setMaterialsReleased({ id: s.id, released: true })).toMatchObject({ ok: true });
    const access = await getEventAccess(h.db, booked.id);
    expect(access.materials).toEqual([{ name: "slides.pdf", url: expect.stringMatching(new RegExp(`^/api/public/files/${added.data.fileId}\\?t=`)) }]);

    expect(await media.removeSessionMaterial({ id: s.id, fileId: added.data.fileId })).toMatchObject({ ok: true });
    expect((await reload(s.id)).materialFileIds).toEqual([]);
  });
});

describe("registrations: CSV rows and bookings.register_webinargeek", () => {
  it("exports live seats only and registers a confirmed seat in WebinarGeek once (job run twice)", async () => {
    const s = await created({ ...webinar, webinarGeekBroadcastId: "777" });
    const an = await makePerson(h.db, { email: "an@example.com", firstName: "An", lastName: "Peeters" });
    const seat = await addBooking(h.db, s.id, { personId: an.id });
    await addBooking(h.db, s.id, { status: "cancelled" });

    const fake = createWebinarGeekFake();
    setWebinarGeekClient(fake);
    const { first, second } = await runJobTwice(h.db, "bookings.register_webinargeek", { bookingId: seat.id });
    expect(first).toEqual({ registered: "1" });
    expect(second).toEqual({ skipped: "registered" });
    expect(fake.subscriptions).toMatchObject([{ broadcastId: "777", email: "an@example.com", firstName: "An", lastName: "Peeters", externalId: seat.id }]);
    const [b] = await h.db.select().from(bookings).where(eq(bookings.id, seat.id));
    expect(b!.webinarGeekWatchUrl).toMatch(/^https:\/\//);

    const rows = await listEventRegistrations(h.db, s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slice(0, 3)).toEqual(["An", "Peeters", "an@example.com"]);
    expect(rows[0]!.at(-1)).toBe("yes");
  });
});

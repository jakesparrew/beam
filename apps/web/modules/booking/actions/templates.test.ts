import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, sessionExceptions, sessionTemplates } from "@beam/db/schema";
import { createTestDb, makeSession } from "@beam/db/testing";
import { addDays, brusselsDate, isoWeekday, zonedTimeToUtc } from "@beam/core/booking";

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

const actions = await import("./templates");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { FULL_NAME, addBooking, clearSchedule, queued, staffSession } = await import("./booking-p2.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  await clearSchedule(h.db);
  await staffSession(h.db, jar, ["settings.write"]);
});

const today = () => brusselsDate(new Date());
const base = () => ({
  kind: "day" as const,
  name: FULL_NAME,
  weekdays: [2, 3, 4, 5, 6, 7],
  startTimes: ["09:00"],
  durationMinutes: 120,
  capacitySeats: 12,
  creditKind: "day" as const,
  creditCost: 1,
  isMemberOnly: false,
  activeFromOn: today(),
});

describe("createTemplates (booking spec 4.2)", () => {
  it("creates one template per start time and enqueues their sessions", async () => {
    const res = await actions.createTemplates({ ...base(), startTimes: ["16:30", "09:00", "11:30", "14:00"] });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.templateIds).toHaveLength(4);
    const rows = await h.db.select().from(sessionTemplates).orderBy(sessionTemplates.startTime);
    expect(rows.map((r) => r.startTime)).toEqual(["09:00:00", "11:30:00", "14:00:00", "16:30:00"]);
    expect(rows.every((r) => r.isActive && r.version === 1)).toBe(true);
    const jobs = await queued(h.db, "sessions.regenerate_template");
    expect(jobs.map((j) => j.idempotencyKey).sort()).toEqual(rows.map((r) => `regenerate:${r.id}:1`).sort());
    const [audit] = await h.db.select().from(auditLog).where(eq(auditLog.action, "booking.create_templates"));
    expect(audit).toMatchObject({ entityType: "session_template" });
  });

  it("refuses a night without beds and a day without seats (validation)", async () => {
    expect(await actions.createTemplates({ ...base(), kind: "night", capacitySeats: null, creditKind: "night" })).toMatchObject({ ok: false, error: { code: "validation", fields: { capacityBeds: "required" } } });
    expect(await actions.createTemplates({ ...base(), capacitySeats: undefined })).toMatchObject({ ok: false, error: { code: "validation", fields: { capacitySeats: "required" } } });
  });

  it("warns about overlapping rooms and times outside the business hours, and saves anyway", async () => {
    const d = addDays(today(), 7);
    const other = await makeSession(h.db, { startsAt: zonedTimeToUtc(d, "07:30"), endsAt: zonedTimeToUtc(d, "09:00"), location: "Zaal 1" });
    const res = await actions.createTemplates({ ...base(), weekdays: [1, isoWeekday(d)], startTimes: ["07:00"], durationMinutes: 60, location: " zaal 1 " });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.warnings).toEqual(
      expect.arrayContaining([
        { code: "outside_business_hours", detail: "1" },
        { code: "location_overlap", detail: other.id },
      ]),
    );
    // Tuesday to Sunday open 08:30: a 07:00 start is outside on every selected weekday.
    expect(res.data.warnings.filter((w) => w.code === "outside_business_hours")).toHaveLength(isoWeekday(d) === 1 ? 1 : 2);
    expect(await h.db.select().from(sessionTemplates)).toHaveLength(1);
  });

  it("a business-hours template has no warning", async () => {
    const res = await actions.createTemplates({ ...base(), startTimes: ["09:00"], location: "Zaal 2" });
    expect(res).toMatchObject({ ok: true, data: { warnings: [] } });
  });
});

describe("setTemplateActive and updateTemplate (R2, section 8)", () => {
  it("activation is blocked while the name is incomplete in a locale", async () => {
    const res = await actions.createTemplates({ ...base(), name: { "nl-BE": "Dagsessie", en: "Day session" } });
    if (!res.ok) throw new Error("create failed");
    const id = res.data.templateIds[0]!;
    const [draft] = await h.db.select().from(sessionTemplates).where(eq(sessionTemplates.id, id));
    expect(draft).toMatchObject({ isActive: false });
    expect(await queued(h.db, "sessions.regenerate_template")).toHaveLength(0);

    expect(await actions.setTemplateActive({ id, isActive: true })).toMatchObject({ ok: false, error: { code: "validation", fields: { "name.fr-BE": "missing" } } });
    expect(await actions.updateTemplate({ id, expectedVersion: 1, name: FULL_NAME })).toMatchObject({ ok: true, data: { version: 2 } });
    expect(await actions.setTemplateActive({ id, isActive: true })).toMatchObject({ ok: true });
    const [active] = await h.db.select().from(sessionTemplates).where(eq(sessionTemplates.id, id));
    expect(active).toMatchObject({ isActive: true, version: 3 });
    expect((await queued(h.db, "sessions.regenerate_template")).map((j) => j.idempotencyKey)).toEqual([`regenerate:${id}:2`, `regenerate:${id}:3`]);
  });

  it("an edit bumps the version and enqueues the regeneration with regenerate:<id>:<version>", async () => {
    const res = await actions.createTemplates(base());
    if (!res.ok) throw new Error("create failed");
    const id = res.data.templateIds[0]!;
    const upd = await actions.updateTemplate({ id, expectedVersion: 1, capacitySeats: 10, startTime: "10:00" });
    expect(upd).toMatchObject({ ok: true, data: { id, version: 2 } });
    if (!upd.ok) return;
    const jobs = await queued(h.db, "sessions.regenerate_template");
    const job = jobs.find((j) => j.id === upd.data.regenerationJobId)!;
    expect(job).toMatchObject({ idempotencyKey: `regenerate:${id}:2`, payload: { templateId: id } });
    const [row] = await h.db.select().from(sessionTemplates).where(eq(sessionTemplates.id, id));
    expect(row).toMatchObject({ capacitySeats: 10, startTime: "10:00:00", version: 2 });
    // A stale version is a conflict and changes nothing.
    expect(await actions.updateTemplate({ id, expectedVersion: 1, capacitySeats: 8 })).toMatchObject({ ok: false, error: { code: "conflict", message: "stale_version" } });
    // An active template cannot lose a translation.
    expect(await actions.updateTemplate({ id, expectedVersion: 2, name: { "nl-BE": "Alleen NL" } })).toMatchObject({ ok: false, error: { code: "validation" } });
    const [audit] = await h.db.select().from(auditLog).where(eq(auditLog.action, "booking.update_template"));
    expect(audit).toMatchObject({ entityType: "session_template", entityId: id });
  });

  it("deactivation bumps the version and enqueues the regeneration that removes free sessions", async () => {
    const res = await actions.createTemplates(base());
    if (!res.ok) throw new Error("create failed");
    const id = res.data.templateIds[0]!;
    expect(await actions.setTemplateActive({ id, isActive: false })).toMatchObject({ ok: true });
    expect((await queued(h.db, "sessions.regenerate_template")).map((j) => j.idempotencyKey)).toContain(`regenerate:${id}:2`);
  });
});

describe("upsertException and deleteException (R4)", () => {
  it("enqueues regenerate_date with the exception version, reports booked sessions and never cancels them", async () => {
    const onDate = addDays(today(), 10);
    const booked = await makeSession(h.db, { startsAt: zonedTimeToUtc(onDate, "11:30"), templateId: (await h.db.insert(sessionTemplates).values({ kind: "day", name: FULL_NAME, weekdays: [1, 2, 3, 4, 5, 6, 7], startTime: "11:30", durationMinutes: 120, capacitySeats: 12, creditKind: "day", activeFromOn: today() }).returning())[0]!.id });
    await addBooking(h.db, booked.id);
    const closed = { onDate, kind: "closed" as const, name: { "nl-BE": "Dicht", "fr-BE": "Fermé", en: "Closed" } };
    expect(await actions.upsertException({ ...closed, name: { "nl-BE": "Dicht" } })).toMatchObject({ ok: false, error: { code: "validation", fields: { "name.fr-BE": "missing", "name.en": "missing" } } });
    const res = await actions.upsertException(closed);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.conflicts).toEqual([{ sessionId: booked.id, startsAt: booked.startsAt, liveBookings: 1 }]);
    const id = res.data.id;
    expect((await queued(h.db, "sessions.regenerate_date")).map((j) => [j.idempotencyKey, j.payload])).toEqual([[`regenerate_date:${onDate}:${id}:1`, { onDate }]]);

    // Narrowing to special hours bumps the version; the 11:30 block is inside and no longer a conflict.
    const edit = await actions.upsertException({ ...closed, id, kind: "special_hours", opensAt: "10:00", closesAt: "15:00" });
    expect(edit).toMatchObject({ ok: true, data: { id, conflicts: [] } });
    const [row] = await h.db.select().from(sessionExceptions).where(eq(sessionExceptions.id, id));
    expect(row).toMatchObject({ version: 2, opensAt: "10:00:00", closesAt: "15:00:00" });
    expect(await actions.upsertException({ ...closed, kind: "special_hours", opensAt: "15:00", closesAt: "10:00" })).toMatchObject({ ok: false, error: { code: "validation", fields: { closesAt: "not_after_opens" } } });

    expect(await actions.deleteException({ id })).toMatchObject({ ok: true, data: { id, conflicts: [] } });
    expect((await queued(h.db, "sessions.regenerate_date")).map((j) => j.idempotencyKey)).toEqual([`regenerate_date:${onDate}:${id}:1`, `regenerate_date:${onDate}:${id}:2`, `regenerate_date:${onDate}:${id}:deleted`]);
    expect(await h.db.select().from(sessionExceptions)).toHaveLength(0);
  });
});

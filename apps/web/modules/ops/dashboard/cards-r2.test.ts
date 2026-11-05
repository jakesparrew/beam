/**
 * ops rules 29 and 31 from R2 (ops-P7): the action dashboard cards over other modules' api.
 * Webinar's `countWebinarLeadsWithoutBooking` / `listWebinarLeadsWithoutBooking` and credits'
 * `countSharingReviewItems` / `listSharingReview` are mocked to the shapes their contracts
 * promise; the imported registrations and the flagged waitlist entries are real rows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { waitlistEntries } from "@beam/db/schema";
import { RETENTION_DEFAULTS } from "@beam/core/ops";
import { createTestDb, makeSession } from "@beam/db/testing";
import { makeCreditGrant } from "@beam/db/testing/credits-factories";

vi.mock("@/modules/webinar/api", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  countWebinarLeadsWithoutBooking: vi.fn(),
  listWebinarLeadsWithoutBooking: vi.fn(),
}));
vi.mock("@/modules/credits/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), countSharingReviewItems: vi.fn(), listSharingReview: vi.fn() }));

const { countWebinarLeadsWithoutBooking, listWebinarLeadsWithoutBooking } = await import("@/modules/webinar/api");
const { countSharingReviewItems, listSharingReview } = await import("@/modules/credits/api");
const { resetRuntime, staffActor } = await import("@/lib/testing");
const { getActionDashboard } = await import("./queries");
const { SHARING_REVIEW_HREF } = await import("./cards");
const { ago, makeCustomer, makeImportedRegistration } = await import("./ops-p3.fixtures");

let h: DbHandle;
const NOW = new Date("2026-11-05T10:00:00Z");
const DAY = 86_400_000;
const WEBINAR_ID = "3f1d2c4b-5a6e-4f70-8a9b-0c1d2e3f4a5b";

const ctxFor = (permissions: string[] = ["reports.read", "tasks.all", "credits.read"]) => ({ tx: h.db, actor: staffActor({ permissions }), now: NOW, locale: "en" as const });
const card = async (key: "webinar_leads_not_booked" | "shared_package_abuse", opts: { view?: "today" | "week"; permissions?: string[] } = {}) =>
  (await getActionDashboard(ctxFor(opts.permissions), { view: opts.view, expand: key })).find((c) => c.key === key);

beforeAll(async () => {
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  vi.mocked(countWebinarLeadsWithoutBooking).mockReset().mockResolvedValue(0);
  vi.mocked(listWebinarLeadsWithoutBooking).mockReset().mockResolvedValue([]);
  vi.mocked(countSharingReviewItems).mockReset().mockResolvedValue(0);
  vi.mocked(listSharingReview).mockReset().mockResolvedValue([]);
});

describe("rule 29 (R2): webinar_leads_not_booked", () => {
  it("counts with countWebinarLeadsWithoutBooking since now - webinar_lead_window_days and lists listWebinarLeadsWithoutBooking rows", async () => {
    const lead = await makeCustomer(h.db, { firstName: "Lotte", lastName: "Maes" });
    const registeredAt = new Date(NOW.getTime() - 3 * DAY);
    vi.mocked(countWebinarLeadsWithoutBooking).mockResolvedValue(7);
    vi.mocked(listWebinarLeadsWithoutBooking).mockResolvedValue([{ personId: lead.id, webinarId: WEBINAR_ID, registeredAt }]);
    const c = (await card("webinar_leads_not_booked"))!;
    const since = new Date(NOW.getTime() - RETENTION_DEFAULTS.webinar_lead_window_days * DAY);
    expect(vi.mocked(countWebinarLeadsWithoutBooking)).toHaveBeenCalledWith(h.db, { startedSince: since });
    expect(vi.mocked(listWebinarLeadsWithoutBooking)).toHaveBeenCalledWith(h.db, { startedSince: since, limit: 50 });
    expect(c.count).toBe(7);
    expect(c.rows[0]).toEqual({ personId: lead.id, name: "Lotte Maes", refType: "webinar", refId: WEBINAR_ID, params: { date: registeredAt.toISOString() } });
    expect(c.canCreateTask).toBe(true);
  });

  it("shows the imported registrations apart as the second figure, their rows after the native ones", async () => {
    const native = await makeCustomer(h.db);
    const old = await makeCustomer(h.db);
    const imported = await makeImportedRegistration(h.db, { personId: old.id, registeredAt: ago(4, NOW), webinarStartsAt: ago(2, NOW) });
    vi.mocked(countWebinarLeadsWithoutBooking).mockResolvedValue(1);
    vi.mocked(listWebinarLeadsWithoutBooking).mockResolvedValue([{ personId: native.id, webinarId: WEBINAR_ID, registeredAt: ago(1, NOW) }]);
    const c = (await card("webinar_leads_not_booked"))!;
    expect(c.count).toBe(1);
    expect(c.secondary).toEqual({ key: "imported", count: expect.any(Number) });
    expect(c.secondary!.count).toBeGreaterThanOrEqual(1);
    expect(c.rows[0]!.personId).toBe(native.id);
    expect(c.rows.slice(1).map((r) => r.refId)).toContain(imported.id);
  });

  it("the week view widens the window by dashboard_week_horizon_days", async () => {
    await card("webinar_leads_not_booked", { view: "week" });
    const since = new Date(NOW.getTime() - (RETENTION_DEFAULTS.webinar_lead_window_days + RETENTION_DEFAULTS.dashboard_week_horizon_days) * DAY);
    expect(vi.mocked(countWebinarLeadsWithoutBooking)).toHaveBeenCalledWith(h.db, { startedSince: since });
  });
});

describe("rule 31 (R2): shared_package_abuse", () => {
  it("counts countSharingReviewItems plus the flagged waitlist entries; credits' rows first; links to credits' review", async () => {
    const owner = await makeCustomer(h.db, { firstName: "Gert", lastName: "Wouters" });
    const guest = await makeCustomer(h.db);
    const grant = await makeCreditGrant(h.db, { personId: owner.id, units: 10 });
    vi.mocked(countSharingReviewItems).mockResolvedValue(2);
    vi.mocked(listSharingReview).mockResolvedValue([
      { rule: "many_guests", grantId: grant.id, guestPersonId: null, personIds: ["a", "b", "c", "d"], distinctCount: 4, lastAt: ago(1, NOW) },
      { rule: "guest_hopping", grantId: null, guestPersonId: guest.id, personIds: ["e", "f", "g"], distinctCount: 3, lastAt: ago(2, NOW) },
    ]);
    const flagged = await makeCustomer(h.db);
    const session = await makeSession(h.db, { startsAt: new Date(Date.now() + 5 * DAY) });
    const [entry] = await h.db.insert(waitlistEntries).values({ sessionId: session.id, personId: flagged.id, isFlaggedDuplicate: true }).returning();
    const quiet = await makeCustomer(h.db);
    await h.db.insert(waitlistEntries).values({ sessionId: session.id, personId: quiet.id });

    const c = (await card("shared_package_abuse"))!;
    expect(c.count).toBe(3);
    expect(vi.mocked(listSharingReview)).toHaveBeenCalledWith(h.db, { limit: 50 });
    expect(c.rows.slice(0, 2)).toEqual([
      { personId: owner.id, name: "Gert Wouters", refType: "credit_grant", refId: grant.id, params: expect.objectContaining({ guests: 4, rule: "many_guests" }) },
      expect.objectContaining({ personId: guest.id, refType: "person", refId: guest.id, params: expect.objectContaining({ guests: 3 }) }),
    ]);
    expect(c.rows[2]).toMatchObject({ personId: flagged.id, refType: "waitlist_entry", refId: entry!.id });
    expect(c.rows.map((r) => r.personId)).not.toContain(quiet.id);
    expect(c.linkHref).toBe(SHARING_REVIEW_HREF);
  });

  it("is hidden without credits.read", async () => {
    expect(await card("shared_package_abuse", { permissions: ["reports.read", "tasks.all"] })).toBeUndefined();
  });
});

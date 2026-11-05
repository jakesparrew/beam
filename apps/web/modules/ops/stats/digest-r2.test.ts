/**
 * ops rule 71 from R2 (ops-P7): the daily digest's webinar section lists the webinars of the
 * next 48 hours from webinar's `listUpcomingWebinarHealth` (mocked) with ids and states only:
 * never a title or the broadcast error text. Every other source is mocked as in `digest.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { createTestDb } from "@beam/db/testing";

vi.mock("@/lib/alerts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), notifySlack: vi.fn() }));
vi.mock("@/modules/automation/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), countAutomationIssues: vi.fn() }));
vi.mock("@/modules/crm/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), countSegmentRefreshErrors: vi.fn() }));
vi.mock("@/modules/forms/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getFormsHealth: vi.fn() }));
vi.mock("@/modules/booking/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getBookingHealth: vi.fn() }));
vi.mock("@/modules/finance/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getFinanceDigest: vi.fn() }));
vi.mock("@/modules/platform/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPlatformDigest: vi.fn() }));
vi.mock("@/modules/webinar/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), listUpcomingWebinarHealth: vi.fn() }));

const { notifySlack } = await import("@/lib/alerts");
const { countAutomationIssues } = await import("@/modules/automation/api");
const { countSegmentRefreshErrors } = await import("@/modules/crm/api");
const { getFormsHealth } = await import("@/modules/forms/api");
const { getBookingHealth } = await import("@/modules/booking/api");
const { getFinanceDigest } = await import("@/modules/finance/api");
const { getPlatformDigest } = await import("@/modules/platform/api");
const { listUpcomingWebinarHealth } = await import("@/modules/webinar/api");
const { sql } = await import("@/lib/ctx");
const { fakeSentry, makeJobCtx } = await import("@/lib/testing");
const { runDigest } = await import("./digest");

let h: DbHandle;
let sentry: ReturnType<typeof fakeSentry>;
const now = new Date();
const LIVE = "11111111-2222-4333-8444-555555555555";
const REPLAY = "66666666-7777-4888-9999-aaaaaaaaaaaa";

beforeAll(async () => {
  h = await createTestDb();
  sentry = fakeSentry();
});
afterAll(async () => {
  sentry.restore();
  await h.close();
});
beforeEach(async () => {
  vi.mocked(notifySlack).mockReset().mockResolvedValue({ jobId: randomUUID(), inserted: true });
  vi.mocked(countAutomationIssues).mockReset().mockResolvedValue({ failed: 0, skippedTranslation: 0, stuck: 0, evaluatorLagSeconds: 0 });
  vi.mocked(countSegmentRefreshErrors).mockReset().mockResolvedValue(0);
  vi.mocked(getFormsHealth).mockReset().mockResolvedValue({ completions: 0, started: 0, importFailed: 0, importSkipped: 0, deadJobs: 0, formsWithBrokenCtas: 0 });
  vi.mocked(getBookingHealth).mockReset().mockResolvedValue({ level: "ok", materialisedThroughOn: "2027-01-31", overdueOffers: 0, overdueReservations: 0, unsentConfirmations24h: 0 });
  vi.mocked(getPlatformDigest).mockReset().mockResolvedValue({ title: "Platform", lines: [] });
  vi.mocked(getFinanceDigest).mockReset().mockResolvedValue({ title: "Finance", lines: [] });
  vi.mocked(listUpcomingWebinarHealth).mockReset();
  await h.db.execute(sql`delete from ops_state where key = 'digest_last_sent_on'`);
});

const run = () => runDigest(makeJobCtx(h.db, "ops.daily_digest", { now }));
const text = () => vi.mocked(notifySlack).mock.calls[0]![1].text;

describe("ops.daily_digest webinar section (rule 71, R2)", () => {
  it("lists the next 48 hours' webinars with ids and states only", async () => {
    vi.mocked(listUpcomingWebinarHealth).mockResolvedValue([
      { webinarId: REPLAY, title: "Slaap beter met ademwerk", startsAt: new Date(now.getTime() + 30 * 3_600_000), mode: "simulive", youtubeLifecycle: null, broadcastError: null, registrations: 12 },
      {
        webinarId: LIVE,
        title: "Koude training voor beginners",
        startsAt: new Date(now.getTime() + 3 * 3_600_000),
        mode: "live",
        youtubeLifecycle: "ready",
        broadcastError: "Stream key rejected for Koude training",
        registrations: 40,
      },
    ]);
    await run();
    expect(vi.mocked(listUpcomingWebinarHealth)).toHaveBeenCalledWith(expect.anything(), { hours: 48 });
    const t = text();
    expect(t).toContain("*Webinars*\n- next 48 h 2");
    expect(t).toContain(`- (!) ${LIVE}: live, broadcast ready, broadcast error`);
    expect(t).toContain(`- ${REPLAY}: simulive, broadcast none`);
    expect(t.indexOf(LIVE)).toBeLessThan(t.indexOf(REPLAY));
    for (const secret of ["Slaap beter", "Koude training", "Stream key"]) expect(t).not.toContain(secret);
    expect(t.indexOf("*Webinars*")).toBeLessThan(t.indexOf("*Platform*"));
  });

  it("says unavailable when the source throws, and the rest still posts", async () => {
    vi.mocked(listUpcomingWebinarHealth).mockRejectedValue(new Error("webinar down"));
    const result = (await run()) as { unavailable: string[] };
    expect(result.unavailable).toEqual(["Webinars"]);
    expect(text()).toContain("*Webinars*: unavailable");
  });
});

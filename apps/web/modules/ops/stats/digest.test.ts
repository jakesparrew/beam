/**
 * ops rule 71 and edge cases 26 and 37: the daily digest. Every other module's source is mocked;
 * the message holds counts, ids and slugs only; a throwing source prints "unavailable" and the
 * rest still posts; `notifySlack` is called once with fingerprint `digest`; a second run on the
 * same day posts nothing.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { emailMessages, forms, formVersions, formViewsDaily } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { brusselsDate } from "@beam/core/ops";

vi.mock("@/lib/alerts", async (orig) => ({ ...(await orig<Record<string, unknown>>()), notifySlack: vi.fn() }));
vi.mock("@/modules/automation/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), countAutomationIssues: vi.fn() }));
vi.mock("@/modules/crm/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), countSegmentRefreshErrors: vi.fn() }));
vi.mock("@/modules/forms/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getFormsHealth: vi.fn() }));
vi.mock("@/modules/booking/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getBookingHealth: vi.fn() }));
vi.mock("@/modules/finance/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getFinanceDigest: vi.fn() }));
vi.mock("@/modules/platform/api", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getPlatformDigest: vi.fn() }));

const { notifySlack } = await import("@/lib/alerts");
const { countAutomationIssues } = await import("@/modules/automation/api");
const { countSegmentRefreshErrors } = await import("@/modules/crm/api");
const { getFormsHealth } = await import("@/modules/forms/api");
const { getBookingHealth } = await import("@/modules/booking/api");
const { getFinanceDigest } = await import("@/modules/finance/api");
const { getPlatformDigest } = await import("@/modules/platform/api");
const { sql } = await import("@/lib/ctx");
const { fakeSentry, makeJobCtx } = await import("@/lib/testing");
const { makeCustomer } = await import("./ops-p2.fixtures");
const { previousDay, runDigest } = await import("./digest");

let h: DbHandle;
let sentry: ReturnType<typeof fakeSentry>;
const now = new Date();
const today = brusselsDate(now);
const day = previousDay(today);

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
  vi.mocked(countAutomationIssues).mockReset().mockResolvedValue({ failed: 2, skippedTranslation: 1, stuck: 3, evaluatorLagSeconds: 42 });
  vi.mocked(countSegmentRefreshErrors).mockReset().mockResolvedValue(4);
  vi.mocked(getFormsHealth).mockReset().mockResolvedValue({ completions: 11, started: 17, importFailed: 1, importSkipped: 2, deadJobs: 0, formsWithBrokenCtas: 1 });
  vi.mocked(getBookingHealth).mockReset().mockResolvedValue({ level: "warn", materialisedThroughOn: "2027-01-31", overdueOffers: 5, overdueReservations: 6, unsentConfirmations24h: 7 });
  vi.mocked(getPlatformDigest).mockReset().mockResolvedValue({ title: "Platform", lines: [{ label: "Dead jobs (24 h)", value: "8", level: "warn" }] });
  vi.mocked(getFinanceDigest).mockReset().mockResolvedValue({ title: "Finance", lines: [{ label: "Billit failures", value: "9", level: "alert" }] });
  await h.db.execute(sql`delete from ops_state where key = 'digest_last_sent_on'`);
});

const run = () => runDigest(makeJobCtx(h.db, "ops.daily_digest", { now }));
const posted = () => vi.mocked(notifySlack).mock.calls.map((c) => c[1]);

async function publishedForm(slug: string, views: number) {
  const [form] = await h.db.insert(forms).values({ slug, kind: "lead", name: { "nl-BE": "F", "fr-BE": "F", en: "F" } }).returning();
  const [v] = await h.db.insert(formVersions).values({ formId: form!.id, version: 1, definition: {} as never, definitionHash: slug, publishedAt: new Date() }).returning();
  await h.db.execute(sql`update forms set status = 'published', current_version_id = ${v!.id} where id = ${form!.id}`);
  await h.db.insert(formViewsDaily).values({ formId: form!.id, dayOn: day, locale: "nl-BE", views });
}

describe("ops.daily_digest (rule 71)", () => {
  it("posts one message with every section, counts only, and a check-form line at 20 views but not at 19", async () => {
    const person = await makeCustomer(h.db);
    const sentAt = new Date(`${day}T10:00:00Z`);
    for (const [i, bounced] of [[1, true], [2, false], [3, false], [4, false]] as const) {
      await h.db.insert(emailMessages).values({
        personId: person.id, toEmail: person.email, kind: "transactional", locale: "nl-BE", idempotencyKey: `digest-test:${i}:${randomUUID()}`,
        status: bounced ? "bounced" : "delivered", sentAt, ...(bounced ? { bouncedAt: sentAt, bounceType: "hard" as const } : {}),
      });
    }
    await publishedForm("quiet-form", 20);
    await publishedForm("almost-quiet-form", 19);
    await run();
    expect(posted()).toHaveLength(1);
    const { fingerprint, severity, text } = posted()[0]!;
    expect({ fingerprint, severity }).toEqual({ fingerprint: "digest", severity: "normal" });
    expect(text).toContain(`BEAM daily digest for ${day}`);
    expect(text).toContain("sent 4, bounced 1, complaints 0, bounce rate 25.0 %");
    expect(text).toContain("failed runs 2, skipped translations 1, stuck enrolments 3, evaluator lag 42 s");
    expect(text).toContain("refresh errors 4");
    expect(text).toContain("completions 11, starts 17, import failures 1, import skips 2, broken CTAs 1");
    expect(text).toContain("check form quiet-form (20 views, 0 completions)");
    expect(text).not.toContain("check form almost-quiet-form");
    expect(text).toContain("materialised through 2027-01-31, overdue offers 5, overdue reservations 6, unsent confirmations (24 h) 7");
    expect(text).toContain("Dead jobs (24 h): 8");
    expect(text).toContain("Billit failures: 9");
    expect(text).not.toMatch(/[^\s@]+@[^\s@]+\.[a-z]{2,}/i);
    expect(text).not.toContain(person.firstName!);
    expect(text).not.toContain(person.lastName!);
    expect(vi.mocked(getFormsHealth)).toHaveBeenCalledWith(expect.anything(), { day });
    expect(vi.mocked(getPlatformDigest)).toHaveBeenCalledWith(expect.anything(), day);
    expect(vi.mocked(getFinanceDigest)).toHaveBeenCalledWith(expect.anything(), day);
  });

  it("a throwing source prints unavailable and the rest still posts (edge case 37)", async () => {
    vi.mocked(countAutomationIssues).mockRejectedValue(new Error("automation down"));
    vi.mocked(getFinanceDigest).mockRejectedValue(new Error("finance down"));
    const result = (await run()) as { unavailable: string[] };
    expect(result.unavailable).toEqual(["Automation", "Finance"]);
    const { text } = posted()[0]!;
    expect(text).toContain("*Automation*: unavailable");
    expect(text).toContain("*Finance*: unavailable");
    expect(text).toContain("refresh errors 4");
    expect(text).toContain("Dead jobs (24 h): 8");
    expect(sentry.exceptions.length).toBeGreaterThanOrEqual(2);
  });

  it("a second run on the same day posts nothing (digest_last_sent_on)", async () => {
    await run();
    expect(await run()).toMatchObject({ skipped: "already_sent" });
    expect(posted()).toHaveLength(1);
  });
});

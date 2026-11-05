/**
 * A-32 in `automation.step` (automation-P7): a marketing email step over the day or week cap
 * writes `skipped_frequency_cap` and the enrolment advances; inside the quiet hours it is
 * deferred (a new `scheduled` row, `next_step_at` moved, the step enqueued again under the
 * `:defer:` key at 08:00 Brussels) and sends when that job runs; transactional templates are
 * never capped or deferred. Email's functions are mocked to the shapes of their contracts: the
 * queue functions write the `email_messages` row (`kind = automation`, with the purpose for a
 * marketing message) that the cap counts.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { emailMessages, emailTemplates, emailTemplateVersions, jobs as jobsTable, settings } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { like } from "drizzle-orm";
import { and, eq } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import type * as EmailApi from "@/modules/email/api";

const state = vi.hoisted(() => ({
  templates: new Map<string, { templateVersionId: string; kind: "marketing" | "transactional"; purpose: "newsletter" | null; locales: string[] }>(),
  versionId: "",
}));

vi.mock("@/modules/email/api", async (orig) => {
  const { sql: q } = await import("drizzle-orm");
  const queue = (marketing: boolean) =>
    vi.fn(async (ctx: { tx: Tx }, input: { personId: string; enrolmentId: string; idempotencyKey: string }) => {
      const res = await ctx.tx.execute(q`insert into email_messages (person_id, kind, purpose, template_version_id, enrolment_id, locale, idempotency_key)
        values (${input.personId}::uuid, 'automation', ${marketing ? "newsletter" : null}, ${state.versionId}::uuid, ${input.enrolmentId}::uuid, 'nl-BE', ${input.idempotencyKey})
        on conflict (idempotency_key) do update set updated_at = now() returning id::text as id`);
      const messageId = (res as { rows: { id: string }[] }).rows[0]!.id;
      return { messageId, status: "queued", created: true, templateVersionId: state.versionId };
    });
  return {
    ...(await orig<typeof EmailApi>()),
    getPublishedTemplateInfo: vi.fn((_db: unknown, slugs: string[]) =>
      Promise.resolve(new Map(slugs.filter((s) => state.templates.has(s)).map((s) => [s, state.templates.get(s)!]))),
    ),
    getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
    queueMarketingEmail: queue(true),
    queueAutomationEmail: queue(false),
  };
});
vi.mock("@/modules/booking/api", () => ({ nextOpeningAt: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@/modules/commerce/api", () => ({
  getCheckoutRecoveryProps: vi.fn(() => Promise.resolve({ resumeUrl: "https://beam.example.com/r/abc", items: [], totalCents: 1000, locale: "nl-BE" })),
  markCheckoutRecoveryMessage: vi.fn(() => Promise.resolve()),
}));

const { runStep, stepJobKey } = await import("./step");
const f = await import("./automation-p3.fixtures");
const email = await import("@/modules/email/api");

let h: DbHandle;
const ALL = ["nl-BE", "fr-BE", "en"];
const H = 3_600_000;
// Thursday 5 November 2026, 14:00 Brussels (CET, UTC+1): outside the quiet hours.
const noon = new Date("2026-11-05T13:00:00Z");
// 22:30 Brussels: inside the quiet hours (default 21:00-08:00).
const evening = new Date("2026-11-05T21:30:00Z");
// 08:00 Brussels the next morning.
const morning = new Date("2026-11-06T07:00:00Z");

const tx = () => h.db as unknown as Tx;
const run = (enrolmentId: string, stepKey: string, at: Date) => runStep(tx(), { enrolmentId, stepKey, now: at }, { ctx: makeCtx(h.db, { now: at }) });

async function setRules(over: Record<string, unknown> = {}) {
  const value = { max_marketing_per_day: 1, max_marketing_per_week: 3, quiet_start: "21:00", quiet_end: "08:00", webhook_hosts: [], ...over };
  await h.db.insert(settings).values({ key: "automation_rules", value, version: 1 }).onConflictDoUpdate({ target: settings.key, set: { value } });
}

/** A previous automation marketing message of the person, created at `at`. */
async function priorSend(personId: string, at: Date, o: { status?: "queued" | "sent" | "suppressed"; purpose?: "newsletter" | null } = {}) {
  await h.db.insert(emailMessages).values({
    personId,
    kind: "automation",
    purpose: o.purpose === undefined ? "newsletter" : o.purpose,
    templateVersionId: state.versionId,
    locale: "nl-BE",
    idempotencyKey: `prior:${crypto.randomUUID()}`,
    status: o.status ?? "sent",
    createdAt: at,
  });
}

/** An automation with one email step (and a tag after it), a person, an enrolment due at `at`. */
async function setup(template: string, at: Date) {
  const a = await f.makeAutomation(h.db, {
    definition: f.steps([
      { key: "mail", type: "email", template },
      { key: "after", type: "tag", tag: "engaged", at: { from: "previous", minutes: 0 } },
    ]),
    isMarketing: false,
  });
  const p = await makePerson(h.db, { locale: "nl-BE" });
  const id = await f.enrolInto(h.db, a.id, p.id, { now: at });
  await f.makeDue(h.db, id, at);
  return { a, p, id };
}

beforeAll(async () => {
  h = await createTestDb();
  await f.makeTag(h.db, "engaged");
  const [t] = await h.db.insert(emailTemplates).values({ slug: "freq-news", name: "Freq news", kind: "marketing", purpose: "newsletter", status: "published" }).returning();
  const [v] = await h.db
    .insert(emailTemplateVersions)
    .values({ templateId: t!.id, version: 1, document: { schemaVersion: 1, locales: {} } as never, locales: ALL, publishedAt: new Date("2026-01-01T00:00:00Z") })
    .returning();
  state.versionId = v!.id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await h.db.delete(settings).where(eq(settings.key, "automation_rules"));
  state.templates.clear();
  state.templates.set("news", { templateVersionId: state.versionId, kind: "marketing", purpose: "newsletter", locales: ALL });
  state.templates.set("info", { templateVersionId: state.versionId, kind: "transactional", purpose: null, locales: ALL });
});

describe("A-32 frequency cap", () => {
  it("A-32 a second marketing email within 24 hours is skipped_frequency_cap and the enrolment advances", async () => {
    const { p, id } = await setup("news", noon);
    await priorSend(p.id, new Date(noon.getTime() - 5 * H));
    expect(await run(id, "mail", noon)).toMatchObject({ status: "ran", outcome: "skipped_frequency_cap", nextStepKey: "after" });
    const [r] = (await f.runsOfEnrolment(h.db, id)).filter((x) => x.outcome === "skipped_frequency_cap");
    expect(r).toMatchObject({ stepKey: "mail", reason: "cap_day:1", emailMessageId: null });
    expect(email.queueMarketingEmail).not.toHaveBeenCalled();
    expect((await f.enrolmentRow(h.db, id)).plan.find((x) => x.key === "mail")).toMatchObject({ state: "skipped" });
  });

  it("A-32 the week cap counts 7 days; suppressed messages and other kinds do not count", async () => {
    const { p, id } = await setup("news", noon);
    for (const d of [2, 3, 5]) await priorSend(p.id, new Date(noon.getTime() - d * 24 * H));
    expect(await run(id, "mail", noon)).toMatchObject({ outcome: "skipped_frequency_cap" });
    expect((await f.runsOfEnrolment(h.db, id)).find((x) => x.outcome === "skipped_frequency_cap")!.reason).toBe("cap_week:3");

    const other = await setup("news", noon);
    await priorSend(other.p.id, new Date(noon.getTime() - H), { status: "suppressed" });
    await priorSend(other.p.id, new Date(noon.getTime() - 2 * H), { purpose: null });
    await priorSend(other.p.id, new Date(noon.getTime() - 8 * 24 * H));
    expect(await run(other.id, "mail", noon)).toMatchObject({ outcome: "sent" });
  });

  it("A-32 the caps follow settings.automation_rules", async () => {
    await setRules({ max_marketing_per_day: 2 });
    const { p, id } = await setup("news", noon);
    await priorSend(p.id, new Date(noon.getTime() - H));
    expect(await run(id, "mail", noon)).toMatchObject({ outcome: "sent" });
    expect(email.queueMarketingEmail).toHaveBeenCalledTimes(1);
  });

  it("A-32 transactional templates are never capped", async () => {
    const { p, id } = await setup("info", noon);
    for (const d of [1, 2, 3, 4]) await priorSend(p.id, new Date(noon.getTime() - d * H));
    expect(await run(id, "mail", noon)).toMatchObject({ outcome: "sent" });
    expect(email.queueAutomationEmail).toHaveBeenCalledTimes(1);
  });
});

describe("A-32 quiet hours", () => {
  it("A-32 a marketing step due at 22:30 is deferred to 08:00 Brussels with a new scheduled row and the :defer: key, then sends", async () => {
    const { id } = await setup("news", evening);
    const r = await run(id, "mail", evening);
    expect(r).toEqual({ status: "deferred", reason: "quiet_hours", nextStepKey: "mail", until: morning });
    expect(email.queueMarketingEmail).not.toHaveBeenCalled();

    const row = await f.enrolmentRow(h.db, id);
    expect(row).toMatchObject({ status: "active", nextStepKey: "mail" });
    expect(row.nextStepAt!.toISOString()).toBe(morning.toISOString());
    expect(row.plan.find((x) => x.key === "mail")).toMatchObject({ state: "pending", due_at: morning.toISOString() });

    const scheduled = (await f.runsOfEnrolment(h.db, id)).filter((x) => x.outcome === "scheduled" && x.reason === "quiet_hours");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]).toMatchObject({ stepKey: "mail", dedupeKey: `run:${id}:mail:scheduled:defer:2026-11-06T07:00` });
    expect(scheduled[0]!.data).toMatchObject({ due_at: morning.toISOString() });

    const key = stepJobKey(id, "mail", { kind: "defer", at: morning });
    expect(key).toBe(`automation:${id}:mail:defer:2026-11-06T07:00`);
    const [job] = await h.db.select().from(jobsTable).where(eq(jobsTable.idempotencyKey, key));
    expect(job).toMatchObject({ kind: "automation.step", lane: "fast", payload: { enrolmentId: id, stepKey: "mail" } });
    expect(job!.runAt.toISOString()).toBe(morning.toISOString());
    expect(await f.stepOutcomes(h.db, id)).toEqual([]);

    // The deferred job at 08:00 sends.
    expect(await run(id, "mail", morning)).toMatchObject({ status: "ran", outcome: "sent", nextStepKey: "after" });
    expect(email.queueMarketingEmail).toHaveBeenCalledTimes(1);
  });

  it("A-32 running the deferral twice writes one scheduled row and one job", async () => {
    const { id } = await setup("news", evening);
    await run(id, "mail", evening);
    await run(id, "mail", new Date(evening.getTime() + 60_000));
    expect((await f.runsOfEnrolment(h.db, id)).filter((x) => x.reason === "quiet_hours")).toHaveLength(1);
    const deferJobs = await h.db.select().from(jobsTable).where(and(eq(jobsTable.kind, "automation.step"), like(jobsTable.idempotencyKey, `automation:${id}:mail:defer:%`)));
    expect(deferJobs).toHaveLength(1);
  });

  it("A-32 after the deferral the caps are judged at send time", async () => {
    const { p, id } = await setup("news", evening);
    await run(id, "mail", evening);
    await priorSend(p.id, new Date(morning.getTime() - H));
    expect(await run(id, "mail", morning)).toMatchObject({ outcome: "skipped_frequency_cap" });
  });

  it("A-32 transactional templates are never deferred", async () => {
    const { id } = await setup("info", evening);
    expect(await run(id, "mail", evening)).toMatchObject({ status: "ran", outcome: "sent" });
    expect(email.queueAutomationEmail).toHaveBeenCalledTimes(1);
  });

  it("A-32 the quiet hours follow settings.automation_rules", async () => {
    await setRules({ quiet_start: "23:00", quiet_end: "07:00" });
    const { id } = await setup("news", evening);
    expect(await run(id, "mail", evening)).toMatchObject({ outcome: "sent" });
  });
});

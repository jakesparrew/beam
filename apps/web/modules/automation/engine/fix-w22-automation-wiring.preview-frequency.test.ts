/**
 * `previewSteps` predicts A-32 (fix-w22-automation-wiring, automation-P7 request): a marketing
 * email step over the day cap is `frequency_cap` (reason `cap_day:<n>`), a second marketing step
 * of the same journey counts the first predicted send, a step due in the quiet hours is
 * `will_send` at the end of the quiet hours (reason `quiet_hours`), and transactional templates
 * are never capped or deferred. Each prediction is checked against what `runStep` writes for the
 * same facts. Email is mocked to the shapes of its contract (CONVENTIONS 11), as in
 * `step-frequency.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { emailMessages, emailTemplates, emailTemplateVersions, settings } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { Definition } from "@beam/core/automation";
import { eq } from "@/lib/ctx";
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

const { runStep } = await import("./step");
const { predictFrequency, previewSteps } = await import("./preview");
const f = await import("./automation-p3.fixtures");

let h: DbHandle;
const ALL = ["nl-BE", "fr-BE", "en"];
const H = 3_600_000;
// Thursday 5 November 2026, 14:00 Brussels (CET, UTC+1): outside the quiet hours.
const noon = new Date("2026-11-05T13:00:00Z");
// 22:30 Brussels: inside the quiet hours (default 21:00-08:00).
const evening = new Date("2026-11-05T21:30:00Z");
// 08:00 Brussels the next morning.
const morning = new Date("2026-11-06T07:00:00Z");
const RULES = { max_marketing_per_day: 1, max_marketing_per_week: 3, quiet_start: "21:00", quiet_end: "08:00", webhook_hosts: [] };

const tx = () => h.db as unknown as Tx;
const run = (enrolmentId: string, stepKey: string, at: Date) => runStep(tx(), { enrolmentId, stepKey, now: at }, { ctx: makeCtx(h.db, { now: at }) });

async function priorSend(personId: string, at: Date) {
  await h.db.insert(emailMessages).values({
    personId,
    kind: "automation",
    purpose: "newsletter",
    templateVersionId: state.versionId,
    locale: "nl-BE",
    idempotencyKey: `prior:${crypto.randomUUID()}`,
    status: "sent",
    createdAt: at,
  });
}

const oneMail = (template: string): Definition =>
  f.steps([
    { key: "mail", type: "email", template },
    { key: "after", type: "tag", tag: "engaged", at: { from: "previous", minutes: 0 } },
  ]);

async function setup(def: Definition) {
  const a = await f.makeAutomation(h.db, { definition: def, isMarketing: false });
  const p = await makePerson(h.db, { locale: "nl-BE" });
  return { a, p };
}

const view = (rows: { key: string; outcome: string; reason: string | null; dueAt: Date }[]) => rows.map((r) => [r.key, r.outcome, r.reason, r.dueAt.toISOString()]);

beforeAll(async () => {
  h = await createTestDb();
  await f.makeTag(h.db, "engaged");
  const [t] = await h.db.insert(emailTemplates).values({ slug: "fw22-news", name: "Fw22 news", kind: "marketing", purpose: "newsletter", status: "published" }).returning();
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

describe("A-39 previewSteps predicts A-32", () => {
  it("A-32 a marketing step over the day cap is predicted frequency_cap, as the step job writes", async () => {
    const { a, p } = await setup(oneMail("news"));
    await priorSend(p.id, new Date(noon.getTime() - 5 * H));
    const preview = await previewSteps(h.db, { personId: p.id, automationId: a.id, now: noon });
    expect(view(preview)).toEqual([
      ["mail", "frequency_cap", "cap_day:1", noon.toISOString()],
      ["after", "will_send", null, noon.toISOString()],
    ]);

    const id = await f.enrolInto(h.db, a.id, p.id, { now: noon });
    await f.makeDue(h.db, id, noon);
    expect(await run(id, "mail", noon)).toMatchObject({ status: "ran", outcome: "skipped_frequency_cap" });
    expect((await f.runsOfEnrolment(h.db, id)).find((x) => x.outcome === "skipped_frequency_cap")!.reason).toBe("cap_day:1");
  });

  it("A-32 a second marketing step counts the send the preview predicts before it", async () => {
    const { a, p } = await setup(
      f.steps([
        { key: "first", type: "email", template: "news" },
        { key: "second", type: "email", template: "news", at: { from: "previous", minutes: 60 } },
        { key: "next_day", type: "email", template: "news", at: { from: "previous", minutes: 24 * 60 } },
      ]),
    );
    const preview = await previewSteps(h.db, { personId: p.id, automationId: a.id, now: noon });
    expect(view(preview)).toEqual([
      ["first", "will_send", null, noon.toISOString()],
      ["second", "frequency_cap", "cap_day:1", new Date(noon.getTime() + H).toISOString()],
      ["next_day", "will_send", null, new Date(noon.getTime() + 25 * H).toISOString()],
    ]);
  });

  it("A-32 a marketing step due in the quiet hours is predicted at 08:00 Brussels with reason quiet_hours, as the job defers it", async () => {
    const { a, p } = await setup(oneMail("news"));
    const preview = await previewSteps(h.db, { personId: p.id, automationId: a.id, now: evening });
    expect(view(preview)[0]).toEqual(["mail", "will_send", "quiet_hours", morning.toISOString()]);

    const id = await f.enrolInto(h.db, a.id, p.id, { now: evening });
    await f.makeDue(h.db, id, evening);
    expect(await run(id, "mail", evening)).toMatchObject({ status: "deferred", reason: "quiet_hours", until: morning });
    expect(await run(id, "mail", morning)).toMatchObject({ status: "ran", outcome: "sent" });
  });

  it("A-32 after the deferral the caps are judged at the deferred time", async () => {
    const { a, p } = await setup(oneMail("news"));
    // 20:30 Brussels: the quiet hours are judged first (deferred), then this send caps 08:00.
    await priorSend(p.id, new Date(evening.getTime() - 2 * H));
    const preview = await previewSteps(h.db, { personId: p.id, automationId: a.id, now: evening });
    expect(view(preview)[0]).toEqual(["mail", "frequency_cap", "cap_day:1", morning.toISOString()]);
  });

  it("A-32 a send that caps the due time but not the deferred time does not cap the step", async () => {
    const { a, p } = await setup(oneMail("news"));
    // 23 hours before 22:30: inside the trailing 24 hours of the due time, outside those of 08:00.
    await priorSend(p.id, new Date(evening.getTime() - 23 * H));
    const preview = await previewSteps(h.db, { personId: p.id, automationId: a.id, now: evening });
    expect(view(preview)[0]).toEqual(["mail", "will_send", "quiet_hours", morning.toISOString()]);
  });

  it("A-32 transactional templates are never capped or deferred in the preview", async () => {
    const { a, p } = await setup(oneMail("info"));
    for (const d of [1, 2, 3, 4]) await priorSend(p.id, new Date(evening.getTime() - d * H));
    const preview = await previewSteps(h.db, { personId: p.id, automationId: a.id, now: evening });
    expect(view(preview)[0]).toEqual(["mail", "will_send", null, evening.toISOString()]);
  });

  it("A-32 the preview follows settings.automation_rules", async () => {
    const value = { ...RULES, quiet_start: "23:00", quiet_end: "07:00", max_marketing_per_day: 2 };
    await h.db.insert(settings).values({ key: "automation_rules", value, version: 1 }).onConflictDoUpdate({ target: settings.key, set: { value } });
    const { a, p } = await setup(oneMail("news"));
    await priorSend(p.id, new Date(evening.getTime() - H));
    const preview = await previewSteps(h.db, { personId: p.id, automationId: a.id, now: evening });
    expect(view(preview)[0]).toEqual(["mail", "will_send", null, evening.toISOString()]);
  });
});

describe("predictFrequency", () => {
  it("defers inside the quiet hours, then judges the caps at the end of them", () => {
    expect(predictFrequency(evening, [], RULES)).toEqual({ outcome: "will_send", at: morning, reason: "quiet_hours" });
    expect(predictFrequency(evening, [new Date(morning.getTime() - H)], RULES)).toEqual({ outcome: "frequency_cap", at: morning, reason: "cap_day:1" });
    expect(predictFrequency(noon, [], RULES)).toEqual({ outcome: "will_send", at: noon, reason: null });
  });

  it("a malformed window never loops", () => {
    expect(predictFrequency(noon, [], { ...RULES, quiet_start: "00:00", quiet_end: "23:59" })).toMatchObject({ outcome: "will_send" });
  });
});

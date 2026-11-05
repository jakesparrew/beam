/**
 * `previewSteps` (automation-P6, A-39): the predicted outcome of every step matches what the
 * step job (`runStep`) writes for the same facts (late entry, `unless`, marketing reachability,
 * missing translation, missing template, a plain step), the preview of an active enrolment lists
 * its remaining steps only, and a preview writes no row anywhere. Email is mocked to the shapes
 * its contract promises (CONVENTIONS 11); crm runs for real; booking and commerce are mocked
 * because the step job imports them.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { auditLog, automationEnrolments, automationRuns, emailMessages, jobs, personTags } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { Definition } from "@beam/core/automation";
import { and, eq, sql } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import type * as EmailApi from "@/modules/email/api";

const state = vi.hoisted(() => ({
  templates: new Map<string, { templateVersionId: string; kind: "marketing" | "transactional"; purpose: "newsletter" | "events" | null; locales: string[] }>(),
  unreachable: new Set<string>(),
}));

vi.mock("@/modules/email/api", async (orig) => {
  const { sql: q } = await import("drizzle-orm");
  const queue = (kind: string) =>
    vi.fn(async (ctx: { tx: Tx }, input: { personId: string; enrolmentId: string; idempotencyKey: string }) => {
      const res = await ctx.tx.execute(q`insert into email_messages (person_id, kind, enrolment_id, locale, idempotency_key)
        values (${input.personId}::uuid, 'transactional', ${input.enrolmentId}::uuid, 'nl-BE', ${`${kind}:${input.idempotencyKey}`})
        on conflict (idempotency_key) do update set updated_at = now() returning id::text as id`);
      const messageId = (res as { rows: { id: string }[] }).rows[0]!.id;
      return { messageId, status: "queued", created: true, templateVersionId: "00000000-0000-4000-8000-0000000000aa" };
    });
  return {
    ...(await orig<typeof EmailApi>()),
    getPublishedTemplateInfo: vi.fn((_db: unknown, slugs: string[]) =>
      Promise.resolve(new Map(slugs.filter((s) => state.templates.has(s)).map((s) => [s, state.templates.get(s)!]))),
    ),
    getReachability: vi.fn((_tx: unknown, personId: string) =>
      Promise.resolve(state.unreachable.has(personId) ? { isReachable: false, blockedReason: "no_consent" } : { isReachable: true, blockedReason: null }),
    ),
    queueMarketingEmail: queue("m"),
    queueAutomationEmail: queue("t"),
  };
});
vi.mock("@/modules/booking/api", () => ({ nextOpeningAt: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@/modules/commerce/api", () => ({
  getCheckoutRecoveryProps: vi.fn(() => Promise.resolve({ resumeUrl: "https://beam.example.com/r/abc", items: [], totalCents: 1000, locale: "nl-BE" })),
  markCheckoutRecoveryMessage: vi.fn(() => Promise.resolve()),
}));

// The engine first, so its imports resolve to the mocks.
const { runStep } = await import("./step");
const { previewSteps } = await import("./preview");
const f = await import("./automation-p3.fixtures");
const crm = await import("@/modules/crm/api");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  for (const k of ["engaged", "vip"]) await f.makeTag(h.db, k);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  state.templates.clear();
  state.unreachable.clear();
  const all = ["nl-BE", "fr-BE", "en"];
  state.templates.set("t-ok", { templateVersionId: "00000000-0000-4000-8000-000000000001", kind: "transactional", purpose: null, locales: all });
  state.templates.set("t-fr", { templateVersionId: "00000000-0000-4000-8000-000000000002", kind: "transactional", purpose: null, locales: ["fr-BE"] });
  state.templates.set("m-promo", { templateVersionId: "00000000-0000-4000-8000-000000000003", kind: "marketing", purpose: "newsletter", locales: all });
});

const now = new Date("2026-11-06T09:00:00Z");
const tx = () => h.db as unknown as Tx;
const HOUR = 60;
const DAY = 24 * HOUR;

/** The run outcome the step job writes, per predicted outcome (A-39 mapping, preview.ts header). */
const JOB_OUTCOME: Record<string, string[]> = {
  will_send: ["sent", "tag_applied"],
  late_entry: ["skipped_late_entry"],
  condition_false: ["skipped_condition"],
  unreachable: ["skipped_unreachable"],
  translation_missing: ["skipped_translation"],
  failed: ["failed"],
};

/** Runs every step of an enrolment in order, each when due, and returns `[step_key, outcome]`. */
async function runAll(enrolmentId: string): Promise<Map<string, string>> {
  for (let i = 0; i < 20; i++) {
    const e = await f.enrolmentRow(h.db, enrolmentId);
    if (e.status !== "active" || !e.nextStepKey || !e.nextStepAt) break;
    const at = e.nextStepAt.getTime() < now.getTime() ? now : e.nextStepAt;
    await runStep(tx(), { enrolmentId, stepKey: e.nextStepKey, now: at }, { ctx: makeCtx(h.db, { now: at }) });
  }
  const runs = await f.runsOfEnrolment(h.db, enrolmentId);
  return new Map(runs.filter((r) => r.stepKey && r.outcome !== "scheduled").map((r) => [r.stepKey!, r.outcome]));
}

async function rowCounts() {
  const n = async (table: typeof automationRuns | typeof automationEnrolments | typeof jobs | typeof emailMessages | typeof auditLog) =>
    (await h.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(table))[0]!.n;
  return { runs: await n(automationRuns), enrolments: await n(automationEnrolments), jobs: await n(jobs), emails: await n(emailMessages), audit: await n(auditLog) };
}

const anchored: Definition = f.steps(
  [
    { key: "reminder_7d", type: "email", template: "t-ok", at: { from: "anchor", minutes: -7 * DAY } },
    { key: "reminder_3d", type: "email", template: "t-ok", at: { from: "anchor", minutes: -3 * DAY } },
    { key: "reminder_day_of", type: "email", template: "t-ok", at: { from: "anchor", minutes: -3 * HOUR } },
  ],
  { anchor: "data.starts_at" },
);

const checks: Definition = f.steps([
  { key: "vip_only", type: "tag", tag: "engaged", unless: { has_tag: "vip" } },
  { key: "promo", type: "email", template: "m-promo" },
  { key: "fr_only", type: "email", template: "t-fr" },
  { key: "gone", type: "email", template: "t-missing" },
  { key: "tag_it", type: "tag", tag: "engaged" },
]);

describe("A-39 previewSteps", () => {
  it("A-39 late entry: a Friday 10:00 entry for a Sunday 10:00 anchor predicts what the job logs", async () => {
    const a = await f.makeAutomation(h.db, { definition: anchored, isMarketing: false });
    const p = await makePerson(h.db, { locale: "nl-BE" });
    const anchorAt = new Date(now.getTime() + 2 * DAY * 60_000);
    const preview = await previewSteps(h.db, { personId: p.id, automationId: a.id, anchorAt, now });
    expect(preview.map((s) => [s.key, s.outcome])).toEqual([
      ["reminder_7d", "late_entry"],
      ["reminder_3d", "late_entry"],
      ["reminder_day_of", "will_send"],
    ]);
    expect(preview[0]!.dueAt.toISOString()).toBe(new Date(anchorAt.getTime() - 7 * DAY * 60_000).toISOString());

    const id = await f.enrolInto(h.db, a.id, p.id, { now, anchorAt });
    // The preview of the active enrolment lists its remaining steps only.
    expect((await previewSteps(h.db, { personId: p.id, automationId: a.id, now })).map((s) => [s.key, s.outcome])).toEqual([["reminder_day_of", "will_send"]]);
    const outcomes = await runAll(id);
    for (const s of preview) expect(JOB_OUTCOME[s.outcome], `${s.key}: preview ${s.outcome}, job ${outcomes.get(s.key)}`).toContain(outcomes.get(s.key));
  });

  it("A-39 unless, reachability, translation and template checks predict the job's outcome for the same facts", async () => {
    const a = await f.makeAutomation(h.db, { definition: checks, isMarketing: false, purpose: null });
    const p = await makePerson(h.db, { locale: "nl-BE" });
    await crm.applyTag(tx(), makeCtx(h.db), p.id, "vip", "manual");
    state.unreachable.add(p.id);
    const preview = await previewSteps(h.db, { personId: p.id, automationId: a.id, now });
    expect(preview.map((s) => [s.key, s.outcome, s.reason])).toEqual([
      ["vip_only", "condition_false", "unless:has_tag"],
      ["promo", "unreachable", "no_consent"],
      ["fr_only", "translation_missing", "locale nl-BE missing in template t-fr"],
      ["gone", "failed", "template_unavailable"],
      ["tag_it", "will_send", null],
    ]);

    const id = await f.enrolInto(h.db, a.id, p.id, { now });
    const outcomes = await runAll(id);
    for (const s of preview) expect(JOB_OUTCOME[s.outcome], `${s.key}: preview ${s.outcome}, job ${outcomes.get(s.key)}`).toContain(outcomes.get(s.key));
    expect(await h.db.select().from(personTags).where(and(eq(personTags.personId, p.id)))).toHaveLength(2);
  });

  it("A-39 a branch the facts do not take is predicted as not taken", async () => {
    const a = await f.makeAutomation(h.db, {
      definition: f.steps([
        { key: "check", type: "condition", if: { has_tag: "vip" }, then: "vip_mail", else: "plain_mail" },
        { key: "vip_mail", type: "email", template: "t-ok" },
        { key: "plain_mail", type: "email", template: "t-ok" },
      ]),
      isMarketing: false,
    });
    const p = await makePerson(h.db, { locale: "en" });
    const preview = await previewSteps(h.db, { personId: p.id, automationId: a.id, now });
    expect(preview.map((s) => [s.key, s.outcome, s.reason])).toEqual([
      ["check", "will_send", "else:plain_mail"],
      ["vip_mail", "condition_false", "branch_not_taken"],
      ["plain_mail", "will_send", null],
    ]);
  });

  it("A-39 a data anchor without anchorAt is refused for a fresh preview", async () => {
    const a = await f.makeAutomation(h.db, { definition: anchored, isMarketing: false });
    const p = await makePerson(h.db);
    await expect(previewSteps(h.db, { personId: p.id, automationId: a.id, now })).rejects.toMatchObject({ message: "anchor_required" });
  });

  it("A-39 a preview writes no row", async () => {
    const a = await f.makeAutomation(h.db, { definition: checks, isMarketing: false, purpose: null });
    const b = await f.makeAutomation(h.db, { definition: anchored, isMarketing: false });
    const p = await makePerson(h.db, { locale: "nl-BE" });
    const before = await rowCounts();
    await previewSteps(h.db, { personId: p.id, automationId: a.id, now });
    await previewSteps(h.db, { personId: p.id, automationId: b.id, anchorAt: new Date(now.getTime() + DAY * 60_000), now });
    expect(await rowCounts()).toEqual(before);
  });
});

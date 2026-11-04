/**
 * `automation.step` (automation-P3): A-26 order of checks, every step type, A-31 email sending
 * through mocked email functions (template kind picks the queue function; status passed
 * through), A-11a, A-33 task owners and due dates, A-34 branching, A-27a anchor moved, A-44.
 * crm functions run for real behind spies; email, booking's `nextOpeningAt` and commerce's
 * checkout recovery are mocked.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automationEnrolments, automations, jobs as jobsTable, personTags, persons, sessions, tasks, users } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { and, eq, inArray, sql } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import type * as CrmApi from "@/modules/crm/api";
import type * as EmailApi from "@/modules/email/api";

const state = vi.hoisted(() => ({
  templates: new Map<string, { templateVersionId: string; kind: "marketing" | "transactional"; purpose: "newsletter" | "events" | null; locales: string[] }>(),
  unreachable: new Set<string>(),
  queueStatus: "queued",
  opening: null as Date | null,
}));

vi.mock("@/modules/email/api", async (orig) => {
  // No import of this module's engine here: it would load the real email api before the mock exists.
  const { sql: q } = await import("drizzle-orm");
  const queue = (kind: string) =>
    vi.fn(async (ctx: { tx: Tx }, input: { personId: string; enrolmentId: string; idempotencyKey: string }) => {
      const res = await ctx.tx.execute(q`insert into email_messages (person_id, kind, enrolment_id, locale, idempotency_key)
        values (${input.personId}::uuid, 'transactional', ${input.enrolmentId}::uuid, 'nl-BE', ${`${kind}:${input.idempotencyKey}`})
        on conflict (idempotency_key) do update set updated_at = now() returning id::text as id`);
      const messageId = (res as { rows: { id: string }[] }).rows[0]!.id;
      return { messageId, status: state.queueStatus, created: true, templateVersionId: "00000000-0000-4000-8000-0000000000aa" };
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
vi.mock("@/modules/crm/api", async (orig) => {
  const m = await orig<typeof CrmApi>();
  return { ...m, createTask: vi.fn(m.createTask), updatePersonFields: vi.fn(m.updatePersonFields), setStatusOverride: vi.fn(m.setStatusOverride) };
});
// booking and commerce are mocked without their real modules: loading them inside the email mock
// (email imports booking, crm imports this module) would bind the engine to the real email api.
vi.mock("@/modules/booking/api", () => ({ nextOpeningAt: vi.fn(() => Promise.resolve(state.opening)) }));
vi.mock("@/modules/commerce/api", () => ({
  getCheckoutRecoveryProps: vi.fn(() => Promise.resolve({ resumeUrl: "https://beam.example.com/r/abc", items: [], totalCents: 1000, locale: "nl-BE" })),
  markCheckoutRecoveryMessage: vi.fn(() => Promise.resolve()),
}));

// The engine first: its imports then resolve to the mocks (an api imported first would load the
// engine inside the email mock factory, bound to the real email module).
const { runStep, stepJobKey } = await import("./step");
const f = await import("./automation-p3.fixtures");
const email = await import("@/modules/email/api");
const crm = await import("@/modules/crm/api");
const booking = await import("@/modules/booking/api");
const commerce = await import("@/modules/commerce/api");

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
  state.queueStatus = "queued";
  state.opening = null;
  vi.clearAllMocks();
});

const now = new Date("2026-11-06T09:00:00Z");
const tx = () => h.db as unknown as Tx;
const run = (enrolmentId: string, stepKey: string, at = now) => runStep(tx(), { enrolmentId, stepKey, now: at }, { ctx: makeCtx(h.db, { now: at }) });

/** An automation with `list`, a person and an enrolment whose first step is due now. */
async function setup(list: Parameters<typeof f.steps>[0], o: { isMarketing?: boolean; over?: Parameters<typeof f.steps>[1]; person?: Parameters<typeof makePerson>[1]; requiresFlag?: string; status?: "active" | "paused" } = {}) {
  const a = await f.makeAutomation(h.db, { definition: f.steps(list, o.over), isMarketing: o.isMarketing ?? false, ...(o.requiresFlag ? { requiresFlag: o.requiresFlag } : {}) });
  const p = await makePerson(h.db, o.person ?? {});
  const id = await f.enrolInto(h.db, a.id, p.id, { now });
  if (o.status === "paused") await h.db.update(automations).set({ status: "paused", pausedAt: now }).where(eq(automations.id, a.id));
  return { a, p, id };
}

const tag = (key: string, k = "engaged", minutes = 0) => ({ key, type: "tag" as const, tag: k, at: { from: "previous" as const, minutes } });

describe("A-26 order of checks", () => {
  it("A-26 a job for another step, or for an ended enrolment, is a no-op without a run", async () => {
    const { id } = await setup([tag("s1"), tag("s2")]);
    expect(await run(id, "s2")).toEqual({ status: "noop", reason: "not_next" });
    await h.db.update(automationEnrolments).set({ status: "exited", endedAt: now, endReason: "manual", nextStepKey: null, nextStepAt: null }).where(eq(automationEnrolments.id, id));
    expect(await run(id, "s1")).toEqual({ status: "noop", reason: "ended" });
    expect(await f.stepOutcomes(h.db, id)).toEqual([]);
  });

  it("A-26 a paused automation: no run, the step stays due", async () => {
    const { id } = await setup([tag("s1")], { status: "paused" });
    expect(await run(id, "s1")).toEqual({ status: "noop", reason: "automation_inactive" });
    expect((await f.enrolmentRow(h.db, id)).nextStepKey).toBe("s1");
    expect(await f.stepOutcomes(h.db, id)).toEqual([]);
  });

  it("A-26 an erased person exits the enrolment with erased", async () => {
    const { id, p } = await setup([tag("s1")]);
    await h.db.update(persons).set({ erasedAt: now, email: null, emailHash: null }).where(eq(persons.id, p.id));
    expect(await run(id, "s1")).toMatchObject({ status: "ran", outcome: "exited", ended: true });
    expect(await f.enrolmentRow(h.db, id)).toMatchObject({ status: "exited", endReason: "erased" });
  });

  it("A-26 the overdue rule comes before unless, unless before the step", async () => {
    const { id } = await setup([{ key: "mail", type: "email", template: "t-mail", unless: { has_tag: "vip" } }]);
    state.templates.set("t-mail", { templateVersionId: "v", kind: "transactional", purpose: null, locales: ["nl-BE", "fr-BE", "en"] });
    expect(await run(id, "mail", new Date(now.getTime() + 25 * 3_600_000))).toMatchObject({ outcome: "skipped_stale" });
    const second = await setup([{ key: "s1", type: "tag", tag: "engaged", unless: { has_tag: "vip" } }]);
    await crm.applyTag(tx(), makeCtx(h.db), second.p.id, "vip", "manual");
    expect(await run(second.id, "s1")).toMatchObject({ outcome: "skipped_condition" });
    const [r] = (await f.runsOfEnrolment(h.db, second.id)).filter((x) => x.outcome === "skipped_condition");
    expect(r!.reason).toBe("unless:has_tag");
  });

  it("A-11a a step of a flag-off automation writes skipped_condition flag_off:<key> and the enrolment advances", async () => {
    const { id } = await setup([tag("s1"), tag("s2", "engaged", 60)], { requiresFlag: "ff_commerce_checkout_recovery" });
    expect(await run(id, "s1")).toMatchObject({ outcome: "skipped_condition", nextStepKey: "s2" });
    const [r] = (await f.runsOfEnrolment(h.db, id)).filter((x) => x.outcome === "skipped_condition");
    expect(r!.reason).toBe("flag_off:ff_commerce_checkout_recovery");
  });
});

describe("A-31 email steps", () => {
  const all = ["nl-BE", "fr-BE", "en"];

  it("A-31 a marketing template goes through queueMarketingEmail, a transactional one through queueAutomationEmail; context and stepKey always passed", async () => {
    state.templates.set("news-a", { templateVersionId: "v1", kind: "marketing", purpose: "newsletter", locales: all });
    state.templates.set("automation.reminder", { templateVersionId: "v2", kind: "transactional", purpose: null, locales: all });
    const ev = await f.makeEvent(h.db, { personId: (await makePerson(h.db)).id, kind: "test.happened", refType: "booking", refId: "b-1", data: { booking_id: "b-1", other: "x" } });
    const a = await f.makeAutomation(h.db, {
      isMarketing: false,
      definition: f.steps([
        { key: "m1", type: "email", template: "news-a" },
        { key: "t1", type: "email", template: "automation.reminder" },
      ], { trigger: { event: "test.happened" } }),
    });
    const id = await f.enrolInto(h.db, a.id, ev.personId!, { now, event: ev });
    expect(await run(id, "m1")).toMatchObject({ outcome: "sent", nextStepKey: "t1" });
    expect(await run(id, "t1")).toMatchObject({ outcome: "sent", ended: true });
    expect(email.queueMarketingEmail).toHaveBeenCalledTimes(1);
    expect(email.queueAutomationEmail).toHaveBeenCalledTimes(1);
    const input = vi.mocked(email.queueMarketingEmail).mock.calls[0]![1];
    expect(input).toEqual({
      templateSlug: "news-a",
      personId: ev.personId,
      enrolmentId: id,
      idempotencyKey: `automation:${id}:m1`,
      stepKey: "m1",
      context: { ref_type: "booking", ref_id: "b-1", booking_id: "b-1", subject_key: "", enrolment_id: id },
    });
    expect(vi.mocked(email.queueAutomationEmail).mock.calls[0]![1]).toMatchObject({ stepKey: "t1", context: expect.objectContaining({ enrolment_id: id }) });
    const sent = (await f.runsOfEnrolment(h.db, id)).filter((r) => r.outcome === "sent");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.emailMessageId).toBeTruthy();
    expect(sent[0]!.data).toMatchObject({ template_slug: "news-a", template_version_id: expect.any(String) });
  });

  it("A-31 the returned status is the run outcome (skipped_unreachable, skipped_translation unchanged)", async () => {
    state.templates.set("t-x", { templateVersionId: "v", kind: "transactional", purpose: null, locales: all });
    for (const status of ["skipped_unreachable", "skipped_translation"] as const) {
      state.queueStatus = status;
      const { id } = await setup([{ key: "mail", type: "email", template: "t-x" }]);
      expect(await run(id, "mail")).toMatchObject({ outcome: status });
    }
  });

  it("A-31 an unreachable person gets skipped_unreachable for a marketing template; nothing is queued", async () => {
    state.templates.set("news-b", { templateVersionId: "v", kind: "marketing", purpose: "newsletter", locales: all });
    const { id, p } = await setup([{ key: "mail", type: "email", template: "news-b" }]);
    state.unreachable.add(p.id);
    expect(await run(id, "mail")).toMatchObject({ outcome: "skipped_unreachable", ended: true });
    expect(email.queueMarketingEmail).not.toHaveBeenCalled();
    expect(email.getReachability).toHaveBeenCalledWith(expect.anything(), p.id, "newsletter");
  });

  it("A-31 a missing locale gives skipped_translation and the journey continues; no fallback language", async () => {
    state.templates.set("t-nl", { templateVersionId: "v", kind: "transactional", purpose: null, locales: ["nl-BE"] });
    const { id } = await setup([{ key: "mail", type: "email", template: "t-nl" }, tag("after")], { person: { locale: "fr-BE" } });
    expect(await run(id, "mail")).toMatchObject({ outcome: "skipped_translation", nextStepKey: "after" });
    const [r] = (await f.runsOfEnrolment(h.db, id)).filter((x) => x.outcome === "skipped_translation");
    expect(r!.reason).toBe("locale fr-BE missing in template t-nl");
    expect(r!.data).toMatchObject({ template_slug: "t-nl" });
    expect(email.queueAutomationEmail).not.toHaveBeenCalled();
  });

  it("A-31 a template without a published version fails with template_unavailable and advances", async () => {
    const { id } = await setup([{ key: "mail", type: "email", template: "gone" }, tag("after")]);
    expect(await run(id, "mail")).toMatchObject({ outcome: "failed", nextStepKey: "after" });
  });

  it("A-31a commerce.checkout_recovery in abandoned-checkout goes through queueMarketingEmail with the resume url and marks the checkout", async () => {
    state.templates.set("commerce.checkout_recovery", { templateVersionId: "v", kind: "transactional", purpose: null, locales: all });
    const p = await makePerson(h.db);
    const checkoutId = "11111111-1111-4111-8111-111111111111";
    const ev = await f.makeEvent(h.db, { personId: p.id, kind: "checkout.abandoned", refType: "checkout", refId: checkoutId, data: { checkout_id: checkoutId, total_cents: 5000 } });
    const a = await f.makeAutomation(h.db, {
      isMarketing: true,
      purpose: "newsletter",
      definition: f.steps([{ key: "remind_1h", type: "email", template: "commerce.checkout_recovery", send_as: "marketing" }], { trigger: { event: "checkout.abandoned" }, subject: "ref" }),
    });
    const id = await f.enrolInto(h.db, a.id, p.id, { now, event: ev });
    expect(await run(id, "remind_1h")).toMatchObject({ outcome: "sent" });
    expect(email.queueMarketingEmail).toHaveBeenCalledTimes(1);
    expect(email.queueAutomationEmail).not.toHaveBeenCalled();
    expect(email.getReachability).toHaveBeenCalledWith(expect.anything(), p.id, "newsletter");
    expect(vi.mocked(email.queueMarketingEmail).mock.calls[0]![1].context).toMatchObject({ checkout_id: checkoutId, resume_url: "https://beam.example.com/r/abc", subject_key: `checkout:${checkoutId}` });
    expect(commerce.getCheckoutRecoveryProps).toHaveBeenCalledWith(expect.anything(), checkoutId);
    expect(commerce.markCheckoutRecoveryMessage).toHaveBeenCalledWith(expect.anything(), { checkoutId, emailMessageId: expect.any(String) });
  });
});

describe("A-33 other step types", () => {
  it("A-33 tag and untag log tag_applied and tag_removed (also when nothing changes)", async () => {
    const { id, p } = await setup([tag("t1"), tag("t2"), { key: "u1", type: "untag", tag: "engaged" }]);
    await run(id, "t1");
    await run(id, "t2");
    await run(id, "u1");
    expect(await f.stepOutcomes(h.db, id)).toEqual([["t1", "tag_applied"], ["t2", "tag_applied"], ["u1", "tag_removed"], [null, "completed"]]);
    expect(await h.db.select().from(personTags).where(eq(personTags.personId, p.id))).toEqual([]);
  });

  it("A-33 set_field calls updatePersonFields with { preferredChannel } and onlyEmpty false", async () => {
    const { id, p } = await setup([{ key: "f1", type: "set_field", field: "preferred_channel", value: "phone" }]);
    expect(await run(id, "f1")).toMatchObject({ outcome: "field_set" });
    expect(crm.updatePersonFields).toHaveBeenCalledWith(expect.anything(), expect.anything(), p.id, { preferredChannel: "phone" }, { onlyEmpty: false });
  });

  it("A-33 status_override writes status_set with the reason through crm.setStatusOverride", async () => {
    const { id, p } = await setup([{ key: "s1", type: "status_override", value: "customer", reason: "B2C playbook" }]);
    expect(await run(id, "s1")).toMatchObject({ outcome: "status_set" });
    expect(crm.setStatusOverride).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ personId: p.id, status: "customer", source: "automation" }));
  });

  it("A-33 a task step creates a crm task with source automation, the enrolment ref and the step dedupe key", async () => {
    const owner = await f.makeStaff(h.db, "sales", "Sam Sales");
    const { id, p } = await setup([{ key: "call", type: "task", title: "Bel {{trigger.data.who}}", kind: "call", owner_role: "sales", due_in_minutes: 60, priority: "normal" }]);
    expect(await run(id, "call")).toMatchObject({ outcome: "task_created" });
    expect(crm.createTask).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ source: "automation", ref: { type: "automation_enrolment", id }, dedupeKey: `automation:${id}:call`, personId: p.id, ownerUserId: owner.id, kind: "call", title: "Bel " }),
    );
    const [run1] = (await f.runsOfEnrolment(h.db, id)).filter((r) => r.outcome === "task_created");
    expect(run1!.taskId).toBeTruthy();
    expect(booking.nextOpeningAt).toHaveBeenCalledWith(expect.anything(), new Date(now.getTime() + 60 * 60_000));
    expect(vi.mocked(booking.nextOpeningAt).mock.calls[0]).toHaveLength(2);
  });

  it("A-33 the owner is the role member with the fewest open tasks; ties by name", async () => {
    const busy = await f.makeStaff(h.db, "customer_service", "Anna");
    const free = await f.makeStaff(h.db, "customer_service", "Bert");
    const other = await makePerson(h.db);
    await h.db.insert(tasks).values({ ownerUserId: busy.id, personId: other.id, title: "open", kind: "other", createdBy: { kind: "system", id: null } });
    const { id } = await setup([{ key: "t", type: "task", title: "Opvolgen", kind: "follow_up", owner_role: "customer_service", due_in_minutes: 0, priority: "low" }]);
    await run(id, "t");
    expect(vi.mocked(crm.createTask).mock.calls[0]![2]).toMatchObject({ ownerUserId: free.id });
  });

  it("A-33 edge 15 without a role member the owner falls back to management (reason owner_fallback:<role>); without staff the step fails", async () => {
    const manager = await f.makeStaff(h.db, "management", "Mia Manager");
    const { id } = await setup([{ key: "t", type: "task", title: "Opvolgen", kind: "other", owner_role: "finance", due_in_minutes: 0, priority: "low" }]);
    expect(await run(id, "t")).toMatchObject({ outcome: "task_created" });
    expect(vi.mocked(crm.createTask).mock.calls[0]![2]).toMatchObject({ ownerUserId: manager.id });
    const [r] = (await f.runsOfEnrolment(h.db, id)).filter((x) => x.outcome === "task_created");
    expect(r!.reason).toBe("owner_fallback:finance");

    await h.db.update(users).set({ status: "disabled" }).where(inArray(users.roleKey, ["management", "owner"]));
    const second = await setup([{ key: "t", type: "task", title: "Opvolgen", kind: "other", owner_role: "finance", due_in_minutes: 0, priority: "low" }]);
    expect(await run(second.id, "t")).toMatchObject({ outcome: "failed" });
    const [failed] = (await f.runsOfEnrolment(h.db, second.id)).filter((x) => x.outcome === "failed");
    expect(failed!.reason).toBe("no_staff_user");
    await h.db.update(users).set({ status: "active" }).where(inArray(users.roleKey, ["management", "owner"]));
  });

  it("A-33 edge 31 a task due on a closed day or Easter Monday moves to the next opening (reason due_moved:<iso>)", async () => {
    await f.makeStaff(h.db, "sales", "Sam Sales");
    const easterMonday = new Date("2027-03-29T08:00:00Z");
    const tuesday = new Date("2027-03-30T08:00:00Z");
    state.opening = tuesday;
    const { id } = await setup([{ key: "t", type: "task", title: "Bellen", kind: "call", owner_role: "sales", due_in_minutes: 0, priority: "normal" }]);
    await run(id, "t", easterMonday);
    expect(vi.mocked(crm.createTask).mock.calls[0]![2]).toMatchObject({ dueAt: tuesday });
    const [r] = (await f.runsOfEnrolment(h.db, id)).filter((x) => x.outcome === "task_created");
    expect(r!.reason).toBe(`due_moved:${tuesday.toISOString()}`);
  });

  it("A-33 enrol enrols into the target (source enrol_step); a paused target gives skipped_condition target_inactive:<slug>", async () => {
    const target = await f.makeAutomation(h.db, { isMarketing: false, definition: f.steps([tag("x", "engaged", 60)]) });
    const { id, p } = await setup([{ key: "e1", type: "enrol", automation: target.slug }]);
    expect(await run(id, "e1")).toMatchObject({ outcome: "enrolled" });
    const [child] = await h.db.select().from(automationEnrolments).where(and(eq(automationEnrolments.personId, p.id), eq(automationEnrolments.automationId, target.id)));
    expect(child).toMatchObject({ status: "active", source: "enrol_step" });

    const paused = await f.makeAutomation(h.db, { isMarketing: false, status: "paused", definition: f.steps([tag("x")]) });
    const second = await setup([{ key: "e1", type: "enrol", automation: paused.slug }]);
    expect(await run(second.id, "e1")).toMatchObject({ outcome: "skipped_condition" });
    const [r] = (await f.runsOfEnrolment(h.db, second.id)).filter((x) => x.outcome === "skipped_condition");
    expect(r!.reason).toBe(`target_inactive:${paused.slug}`);
  });

  it("A-33 exit ends this enrolment (exit_step) or the named automation's enrolment", async () => {
    const { id } = await setup([{ key: "x", type: "exit" }, tag("never")]);
    expect(await run(id, "x")).toMatchObject({ outcome: "exited", ended: true });
    expect(await f.enrolmentRow(h.db, id)).toMatchObject({ status: "exited", endReason: "exit_step" });

    const other = await f.makeAutomation(h.db, { isMarketing: false, definition: f.steps([tag("x", "engaged", 600)]) });
    const self = await f.makeAutomation(h.db, { isMarketing: false, definition: f.steps([{ key: "x", type: "exit", automation: other.slug }]) });
    const p = await makePerson(h.db);
    const otherId = await f.enrolInto(h.db, other.id, p.id, { now });
    const selfId = await f.enrolInto(h.db, self.id, p.id, { now });
    expect(await run(selfId, "x")).toMatchObject({ outcome: "exited", ended: true });
    expect(await f.enrolmentRow(h.db, otherId)).toMatchObject({ status: "exited", endReason: "exit_step" });
    expect(await f.enrolmentRow(h.db, selfId)).toMatchObject({ status: "completed" });
  });

  it("A-33 notify_slack enqueues a Slack job with the placeholders filled -> notified", async () => {
    const { id, p, a } = await setup([{ key: "n", type: "notify_slack", text: "{{first_name}} {{person_url}} in {{automation}}" }], { person: { firstName: "Lotte" } });
    expect(await run(id, "n")).toMatchObject({ outcome: "notified" });
    const [job] = await h.db.select().from(jobsTable).where(eq(jobsTable.kind, "notify.slack")).orderBy(sql`created_at desc`).limit(1);
    expect(job!.payload).toEqual({ fingerprint: `automation:${a.id}:n:${id}`, severity: "normal", text: `Lotte /admin/persons/${p.id} in ${a.name}` });
  });

  it("A-33 webhook enqueues automation.call_webhook and advances at once without a run", async () => {
    const { id } = await setup([{ key: "w", type: "webhook", url: "https://hooks.example.com/x" }, tag("after", "engaged", 30)]);
    expect(await run(id, "w")).toMatchObject({ outcome: null, nextStepKey: "after" });
    const job = await h.db.select().from(jobsTable).where(eq(jobsTable.idempotencyKey, `automation_webhook:${id}:w`));
    expect(job.map((j) => [j.kind, j.payload])).toEqual([["automation.call_webhook", { enrolmentId: id, stepKey: "w" }]]);
    expect(await f.stepOutcomes(h.db, id)).toEqual([]);
  });
});

describe("A-34 branching", () => {
  it("A-34 a condition branches to its target (branched with result and target); steps between are not_taken", async () => {
    const list = [
      { key: "c", type: "condition" as const, if: { has_tag: "vip" }, then: "yes", else: "no" },
      tag("no"),
      { key: "yes", type: "tag" as const, tag: "engaged", at: { from: "previous" as const, minutes: 120 } },
    ];
    const { id, p } = await setup(list);
    await crm.applyTag(tx(), makeCtx(h.db), p.id, "vip", "manual");
    expect(await run(id, "c")).toMatchObject({ outcome: "branched", nextStepKey: "yes" });
    const row = await f.enrolmentRow(h.db, id);
    expect(row.plan.map((x) => [x.key, x.state])).toEqual([["c", "done"], ["no", "not_taken"], ["yes", "pending"]]);
    expect(row.nextStepAt).toEqual(new Date(now.getTime() + 120 * 60_000));
    const [b] = (await f.runsOfEnrolment(h.db, id)).filter((x) => x.outcome === "branched");
    expect(b!.data).toMatchObject({ result: true, target: "yes", branch: "then" });

    const second = await setup([{ key: "c", type: "condition", if: { has_tag: "vip" }, then: "x", else: "end" }, tag("x")]);
    expect(await run(second.id, "c")).toMatchObject({ outcome: "branched", ended: true });
    expect(await f.enrolmentRow(h.db, second.id)).toMatchObject({ status: "completed", endReason: "completed" });
  });
});

describe("A-27a anchor moved by staff (edge case 10b)", () => {
  it("A-27a re-plans pending steps on the new session start and sends nothing in that run", async () => {
    state.templates.set("automation.event_reminder_day_of", { templateVersionId: "v", kind: "transactional", purpose: null, locales: ["nl-BE", "fr-BE", "en"] });
    const p = await makePerson(h.db);
    const startsAt = new Date("2026-11-08T09:00:00Z");
    const { booking: b, session } = await f.makeBooking(h.db, { personId: p.id, startsAt, status: "confirmed", kind: "event" });
    const ev = await f.makeEvent(h.db, { personId: p.id, kind: "booking.confirmed", refType: "booking", refId: b.id, data: { starts_at: startsAt.toISOString(), session_kind: "event" } });
    const a = await f.makeAutomation(h.db, {
      isMarketing: false,
      definition: f.steps([{ key: "day_of", type: "email", template: "automation.event_reminder_day_of", at: { from: "anchor", minutes: -180 } }], {
        trigger: { event: "booking.confirmed" },
        anchor: "data.starts_at",
        subject: "ref",
      }),
    });
    const id = await f.enrolInto(h.db, a.id, p.id, { now, event: ev });
    const moved = new Date("2026-11-15T09:00:00Z");
    await h.db.update(sessions).set({ startsAt: moved, endsAt: new Date(moved.getTime() + 7_200_000) }).where(eq(sessions.id, session.id));
    const due = new Date(startsAt.getTime() - 180 * 60_000);
    expect(await run(id, "day_of", due)).toEqual({ status: "replanned", reason: "anchor_moved", nextStepKey: "day_of" });
    expect(email.queueAutomationEmail).not.toHaveBeenCalled();
    const row = await f.enrolmentRow(h.db, id);
    expect(row.anchorAt).toEqual(moved);
    expect(row.nextStepAt).toEqual(new Date(moved.getTime() - 180 * 60_000));
    const scheduled = (await f.runsOfEnrolment(h.db, id)).filter((x) => x.outcome === "scheduled");
    expect(scheduled.map((s) => s.reason).sort()).toEqual(["anchor_moved", null]);
    // On the new due time the step sends.
    expect(await run(id, "day_of", row.nextStepAt!)).toMatchObject({ outcome: "sent" });
  });
});

describe("job keys", () => {
  it("A-26a step job keys: plain, :resume: and :defer: in UTC minutes", () => {
    const at = new Date("2026-11-06T09:00:42Z");
    expect(stepJobKey("e1", "s1")).toBe("automation:e1:s1");
    expect(stepJobKey("e1", "s1", { kind: "resume", at })).toBe("automation:e1:s1:resume:2026-11-06T09:00");
  });
});

describe("A-44 protected facts", () => {
  const root = join(__dirname, "..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) return files(p);
      return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$|fixtures\.ts$/.test(n) ? [p] : [];
    });

  it("A-44 no code path of the module writes bookings, waitlist entries, credit entries, orders or payments", () => {
    const tables = ["bookings", "waitlistEntries", "creditEntries", "creditGrants", "orders", "payments"];
    const sqlTables = ["bookings", "waitlist_entries", "credit_entries", "credit_grants", "orders", "payments"];
    const offenders: string[] = [];
    for (const file of files(root)) {
      const src = readFileSync(file, "utf8");
      for (const t of tables) if (new RegExp(`\\.(insert|update|delete)\\(\\s*${t}\\b`).test(src)) offenders.push(`${file}: ${t}`);
      for (const t of sqlTables) if (new RegExp(`(insert\\s+into|update|delete\\s+from)\\s+${t}\\b`, "i").test(src)) offenders.push(`${file}: ${t}`);
    }
    expect(offenders).toEqual([]);
  });
});

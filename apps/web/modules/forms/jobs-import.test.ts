/** forms-P7: `forms.process_import` runs twice with the same payload and leaves the same state (conventions, runJobTwice). */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, consentRecords, formImportEvents, formSensitiveAnswers, formSubmissions } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { Field } from "@beam/core/forms";
import type * as OpsApi from "@/modules/ops/api";

vi.mock("@/modules/ops/api", async (orig) => ({ ...(await orig<typeof OpsApi>()), isDpiaApproved: () => Promise.resolve(true) }));

const { eq, inArray } = await import("@/lib/ctx");
const { makeCtx, resetRuntime, runJobTwice, staffActor } = await import("@/lib/testing");
const { setupEnv, T } = await import("./forms-p3.fixtures");
const { jobs } = await import("./jobs");
const { createImportSource, ingestCsv, receiveImport } = await import("./service/import");

let h: DbHandle;
let userId: string;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
  userId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const staff = () => makeCtx(h.db, { actor: staffActor({ userId, permissions: ["forms.publish"] }), now: new Date("2026-11-04T10:00:00Z") });
const field = (key: string, label: string): Field => ({ key, type: "short_text", label: T(label), required: false, sensitive: false });

async function source() {
  const s = await createImportSource(h.db as never, staff(), {
    provider: "scoreapp",
    name: "ScoreApp twice",
    mapping: {
      email: "lead.email",
      firstName: "lead.first_name",
      externalId: "id",
      score: "score.percentage",
      outcome: "score.tier",
      outcomeMap: { Balanced: "balanced" },
      answers: { sleep_hours: "answers.sleep_hours", goal: "answers.goal" },
      sensitiveFieldKeys: ["sleep_hours"],
      consents: { newsletter: "consents.marketing" },
    },
    mirrorFields: [field("sleep_hours", "Sleep hours"), field("goal", "Goal")],
    outcomes: [{ key: "balanced", label: "Balanced", tagKeys: [] }],
  });
  const secret = s.url.split("/").pop()!;
  return { ...s, secret };
}

describe("job declaration", () => {
  it("declares forms.process_import on the fast lane with 6 attempts and a dead hook", () => {
    const def = jobs.find((j) => j.kind === "forms.process_import");
    expect(def).toMatchObject({ lane: "fast", priority: 5, maxAttempts: 6 });
    expect(def?.onDead).toBeTypeOf("function");
  });
});

describe("runJobTwice", () => {
  it("forms.process_import: one submission, one consent, the same events after the second run", async () => {
    const s = await source();
    const ctx = makeCtx(h.db);
    const body = JSON.parse(readFileSync(new URL("./__fixtures__/scoreapp.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const r = await receiveImport(ctx.tx, ctx, { sourceKey: s.key, secret: s.secret, payload: body });
    const eventId = r.eventId!;
    const state = async () => {
      const subs = await h.db.select({ id: formSubmissions.id, status: formSubmissions.status, personId: formSubmissions.personId, outcomeKey: formSubmissions.outcomeKey }).from(formSubmissions).where(eq(formSubmissions.importEventId, eventId));
      const ids = subs.map((x) => x.id);
      return {
        subs,
        event: (await h.db.select({ status: formImportEvents.status, submissionId: formImportEvents.submissionId, error: formImportEvents.error }).from(formImportEvents).where(eq(formImportEvents.id, eventId)))[0],
        sensitive: ids.length ? (await h.db.select({ k: formSensitiveAnswers.fieldKey }).from(formSensitiveAnswers).where(inArray(formSensitiveAnswers.submissionId, ids))).map((x) => x.k) : [],
        events: ids.length ? (await h.db.select({ kind: activityEvents.kind }).from(activityEvents).where(inArray(activityEvents.refId, ids))).map((e) => e.kind).sort() : [],
        consents: subs[0]?.personId ? (await h.db.select({ p: consentRecords.purpose, m: consentRecords.method }).from(consentRecords).where(eq(consentRecords.personId, subs[0].personId))).length : 0,
      };
    };
    let afterFirst: Awaited<ReturnType<typeof state>> | undefined;
    const out = await runJobTwice(h.db, "forms.process_import", { importEventId: eventId }, { between: async () => void (afterFirst = await state()) });
    expect(out).toEqual({ first: { status: "processed" }, second: { status: "processed" } });
    const final = await state();
    expect(final).toEqual(afterFirst);
    expect(final.subs).toHaveLength(1);
    expect(final.subs[0]).toMatchObject({ status: "completed", outcomeKey: "balanced" });
    expect(final.sensitive).toEqual(["sleep_hours"]);
    expect(final.events).toEqual(["assessment.result_generated", "form.completed"]);
    expect(final.consents).toBe(1);
  });

  it("forms.process_import: a CSV row without email is skipped once and stays skipped", async () => {
    const s = await source();
    await ingestCsv(h.db as never, staff(), s.sourceId, "id,lead.email,answers.goal\nrow-1,,Rest\n");
    const [ev] = await h.db.select().from(formImportEvents).where(eq(formImportEvents.sourceId, s.sourceId));
    const out = await runJobTwice(h.db, "forms.process_import", { importEventId: ev!.id });
    expect(out).toEqual({ first: { status: "skipped" }, second: { status: "skipped" } });
    const [after] = await h.db.select().from(formImportEvents).where(eq(formImportEvents.id, ev!.id));
    expect(after).toMatchObject({ status: "skipped", error: "missing_email" });
    expect(await h.db.select().from(formSubmissions).where(eq(formSubmissions.importEventId, ev!.id))).toHaveLength(0);
  });
});

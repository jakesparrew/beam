/**
 * forms-P7: the ScoreApp and Typeform import stopgap (rules I1 to I5): the webhook route with
 * its secret, duplicate deliveries, processing of the Typeform and ScoreApp fixtures (mapped
 * outcome, sensitive answers only encrypted, no result email, consents only from a literal
 * `true`, suppressions kept), skipped payloads and the CSV backfill.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import {
  activityEvents,
  consentRecords,
  emailMessages,
  formImportEvents,
  formImportSources,
  formSensitiveAnswers,
  formSubmissions,
  forms,
  jobs,
  persons,
} from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { Field, ImportMapping } from "@beam/core/forms";
import type * as OpsApi from "@/modules/ops/api";

vi.mock("@/modules/ops/api", async (orig) => ({ ...(await orig<typeof OpsApi>()), isDpiaApproved: () => Promise.resolve(true) }));

const { and, eq, inArray, setAppDb, sql } = await import("@/lib/ctx");
const { makeCtx, makeJobCtx, resetRuntime, staffActor } = await import("@/lib/testing");
const { addSuppression } = await import("@/modules/crm/api");
const { setupEnv, T } = await import("../forms-p3.fixtures");
const { POST: importRoute } = await import("@/app/api/public/forms/import/[sourceKey]/[secret]/route");
const imp = await import("./import");

const fixture = (name: string): string => readFileSync(new URL(`../__fixtures__/${name}`, import.meta.url), "utf8");
type TypeformBody = { event_id: string; form_response: { hidden: { email: string } } };
type ScoreappBody = { id: string; lead: { email: string } };
const typeformBody = () => JSON.parse(fixture("typeform.json")) as TypeformBody;
const scoreappBody = () => JSON.parse(fixture("scoreapp.json")) as ScoreappBody;

let h: DbHandle;
let staffUserId: string;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
  setAppDb(h.db);
  staffUserId = (await makeUser(h.db)).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const NOW = new Date("2026-11-04T10:00:00Z");
const staffCtx = () => makeCtx(h.db, { actor: staffActor({ userId: staffUserId, permissions: ["forms.publish", "forms.write"] }), now: NOW });

const field = (key: string, type: "short_text" | "number" | "long_text", label: string): Field => ({ key, type, label: T(label), required: false, sensitive: false });

const TYPEFORM_MAPPING: ImportMapping = {
  email: "form_response.hidden.email",
  firstName: "form_response.answers[field.ref=first_name].text",
  locale: "form_response.hidden.lang",
  externalId: "event_id",
  completedAt: "form_response.submitted_at",
  score: "form_response.calculated.score",
  outcome: "form_response.variables[key=outcome].text",
  outcomeMap: { "Rest and recover": "rest", "Keep going": "keep_going" },
  answers: { sleep: "form_response.answers[field.ref=sleep].number", goal: "form_response.answers[field.ref=goal].text" },
  sensitiveFieldKeys: ["sleep"],
  consents: { newsletter: "form_response.answers[field.ref=newsletter].boolean" },
};

const SCOREAPP_MAPPING: ImportMapping = {
  email: "lead.email",
  firstName: "lead.first_name",
  lastName: "lead.last_name",
  locale: "lead.language",
  externalId: "id",
  completedAt: "created_at",
  score: "score.percentage",
  outcome: "score.tier",
  outcomeMap: { Balanced: "balanced", Thriving: "thriving" },
  answers: { sleep_hours: "answers.sleep_hours", stress: "answers.stress", goal: "answers.goal" },
  sensitiveFieldKeys: ["sleep_hours", "stress"],
  consents: { newsletter: "consents.marketing" },
};

async function typeformSource() {
  return imp.createImportSource(h.db as never, staffCtx(), {
    provider: "typeform",
    name: "Typeform recovery check",
    mapping: TYPEFORM_MAPPING,
    mirrorFields: [field("sleep", "number", "Sleep hours"), field("goal", "short_text", "Goal")],
    outcomes: [
      { key: "rest", label: "Rest and recover", tagKeys: [] },
      { key: "keep_going", label: "Keep going", tagKeys: [] },
    ],
  });
}

async function scoreappSource() {
  return imp.createImportSource(h.db as never, staffCtx(), {
    provider: "scoreapp",
    name: "ScoreApp scorecard",
    mapping: SCOREAPP_MAPPING,
    mirrorFields: [field("sleep_hours", "short_text", "Sleep hours"), field("stress", "short_text", "Stress"), field("goal", "short_text", "Goal")],
    outcomes: [
      { key: "balanced", label: "Balanced", tagKeys: [] },
      { key: "thriving", label: "Thriving", tagKeys: [] },
    ],
  });
}

const parts = (url: string) => {
  const m = /\/api\/public\/forms\/import\/([a-z0-9]{12})\/([^/]+)$/.exec(url);
  return { key: m![1]!, secret: m![2]! };
};
let ipN = 0;
function post(key: string, secret: string, body: unknown): Promise<Response> {
  const req = new Request(`https://app.example.com/api/public/forms/import/${key}/${secret}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${(++ipN % 200) + 20}` },
    body: JSON.stringify(body),
  });
  return importRoute(req, { params: Promise.resolve({ sourceKey: key, secret }) });
}
const eventsOfSource = (sourceId: string) => h.db.select().from(formImportEvents).where(eq(formImportEvents.sourceId, sourceId));
const jobsOf = (eventId: string) => h.db.select().from(jobs).where(sql`${jobs.idempotencyKey} like ${`form_import:${eventId}%`}`);
const process = (eventId: string) => {
  const ctx = makeJobCtx(h.db, "forms.process_import", { now: NOW });
  return imp.processImportEvent(ctx.tx, ctx, eventId);
};
const subOf = async (eventId: string) => (await h.db.select().from(formSubmissions).where(eq(formSubmissions.importEventId, eventId)))[0];
const personByEmail = async (email: string) => (await h.db.select().from(persons).where(eq(persons.email, email)))[0];

describe("createImportSource", () => {
  it("publishes an assessment mirror form whose sensitive fields follow the mapping; the secret is only hashed", async () => {
    const s = await typeformSource();
    const [src] = await h.db.select().from(formImportSources).where(eq(formImportSources.id, s.sourceId));
    const [form] = await h.db.select().from(forms).where(eq(forms.id, s.formId));
    expect(form).toMatchObject({ slug: `import-${s.key}`, kind: "assessment", status: "published" });
    const { secret } = parts(s.url);
    expect(src!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(src!.tokenHash).not.toContain(secret);
    expect(imp.secretMatches(secret, src!.tokenHash)).toBe(true);
    expect(imp.secretMatches(`${secret}x`, src!.tokenHash)).toBe(false);
  });

  it("refuses a mapping that addresses a field the mirror does not have", async () => {
    await expect(
      imp.createImportSource(h.db as never, staffCtx(), { provider: "typeform", name: "Broken", mapping: { ...TYPEFORM_MAPPING, answers: { nope: "a.b" } }, mirrorFields: [] }),
    ).rejects.toMatchObject({ code: "validation" });
  });
});

describe("I1: the webhook route", () => {
  it("I1: wrong secret, unknown key or inactive source -> 404 and nothing stored", async () => {
    const s = await typeformSource();
    const { key, secret } = parts(s.url);
    expect((await post(key, "wrong-secret", typeformBody())).status).toBe(404);
    expect((await post("zzzzzzzzzzzz", secret, typeformBody())).status).toBe(404);
    await imp.updateImportSource(h.db as never, staffCtx(), { sourceId: s.sourceId, isActive: false });
    expect((await post(key, secret, typeformBody())).status).toBe(404);
    expect(await eventsOfSource(s.sourceId)).toHaveLength(0);
  });

  it("I1: stores the body once and enqueues the job only for the new row (duplicate ignored)", async () => {
    const s = await typeformSource();
    const { key, secret } = parts(s.url);
    const r1 = await post(key, secret, typeformBody());
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });
    expect((await post(key, secret, typeformBody())).status).toBe(200);
    const events = await eventsOfSource(s.sourceId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ externalId: "01JTFEVENT0000000000000001" });
    expect(events[0]!.emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await jobsOf(events[0]!.id)).toHaveLength(1);
    const [src] = await h.db.select().from(formImportSources).where(eq(formImportSources.id, s.sourceId));
    expect(src!.lastReceivedAt).not.toBeNull();
  });

  it("rotating the secret stops the old URL at once", async () => {
    const s = await typeformSource();
    const old = parts(s.url);
    const fresh = parts((await imp.rotateImportSecret(h.db as never, staffCtx(), s.sourceId)).url);
    expect((await post(old.key, old.secret, typeformBody())).status).toBe(404);
    expect((await post(fresh.key, fresh.secret, typeformBody())).status).toBe(200);
  });
});

describe("I3 and I4: processing", () => {
  it("I3: the Typeform fixture creates a completed submission with the mapped outcome; the sensitive answer only in form_sensitive_answers; no result email", async () => {
    const s = await typeformSource();
    const { key, secret } = parts(s.url);
    await post(key, secret, typeformBody());
    const [ev] = await eventsOfSource(s.sourceId);
    expect(await process(ev!.id)).toBe("processed");

    const sub = await subOf(ev!.id);
    expect(sub).toMatchObject({ status: "completed", identifiedBy: "import", source: "import", externalRef: "01JTFEVENT0000000000000001", outcomeKey: "rest", locale: "nl-BE" });
    expect(sub!.completedAt?.toISOString()).toBe("2026-10-20T09:03:44.000Z");
    expect(sub!.score).toMatchObject({ total: 14 });
    expect(sub!.answers).toEqual({ email: "typeform.lead@example.com", goal: "Sleep better" });
    expect(JSON.stringify(sub!.answers)).not.toContain("sleep\"");
    const sensitive = await h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, sub!.id));
    expect(sensitive.map((r) => r.fieldKey)).toEqual(["sleep"]);
    expect(sensitive[0]!.personId).toBe(sub!.personId);
    expect(Buffer.from(sensitive[0]!.valueEnc).toString("utf8")).not.toBe("5");

    const person = await personByEmail("typeform.lead@example.com");
    expect(person).toMatchObject({ id: sub!.personId, firstName: "Lotte" });
    expect(person!.acquisition).toMatchObject({ source: "import", form_slug: `import-${key}` });
    expect(await h.db.select().from(emailMessages).where(eq(emailMessages.personId, sub!.personId!))).toHaveLength(0);

    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.refType, "form_submission"), eq(activityEvents.refId, sub!.id)));
    const completed = events.find((e) => e.kind === "form.completed");
    expect(completed?.data).toMatchObject({ via_import: true, outcome_key: "rest", score: 14, source: "import" });
    expect(JSON.stringify(completed?.data)).not.toContain("Sleep better");
    expect(events.find((e) => e.kind === "assessment.result_generated")?.data).toMatchObject({ result_email: "not_sent" });

    const [after] = await h.db.select().from(formImportEvents).where(eq(formImportEvents.id, ev!.id));
    expect(after).toMatchObject({ status: "processed", submissionId: sub!.id, error: null });
  });

  it("I3: `newsletter` is never inferred from a non-true value (Typeform's false, a CSV 'yes')", async () => {
    const s = await typeformSource();
    const { key, secret } = parts(s.url);
    const body = typeformBody();
    body.event_id = "01JTFEVENT0000000000000002";
    body.form_response.hidden.email = "no-newsletter@example.com";
    await post(key, secret, body);
    const [ev] = await eventsOfSource(s.sourceId);
    expect(await process(ev!.id)).toBe("processed");
    const sub = await subOf(ev!.id);
    expect(await h.db.select().from(consentRecords).where(eq(consentRecords.personId, sub!.personId!))).toHaveLength(0);
    expect(sub!.consentSnapshot).toEqual([]);
  });

  it("I3: a literal `true` is recorded with method `import` and source `form_import:<key>`", async () => {
    const s = await scoreappSource();
    const { key, secret } = parts(s.url);
    await post(key, secret, scoreappBody());
    const [ev] = await eventsOfSource(s.sourceId);
    expect(await process(ev!.id)).toBe("processed");
    const sub = await subOf(ev!.id);
    expect(sub).toMatchObject({ outcomeKey: "balanced", locale: "fr-BE" });
    const records = await h.db.select().from(consentRecords).where(eq(consentRecords.personId, sub!.personId!));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ purpose: "newsletter", status: "granted", method: "import", source: `form_import:${key}` });
    expect(sub!.consentSnapshot).toEqual([{ purpose: "newsletter", granted: true, wordingVersion: "legacy-import", fieldKey: "import:newsletter" }]);
    const sensitive = await h.db.select({ k: formSensitiveAnswers.fieldKey }).from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, sub!.id));
    expect(sensitive.map((r) => r.k).sort()).toEqual(["sleep_hours", "stress"]);
    expect(sub!.answers).toEqual({ email: "scoreapp.lead@example.com", goal: "More energy" });
  });

  it("I3: an import never lifts a suppression (crm answers skipped_suppressed)", async () => {
    const p = await makePerson(h.db, { email: "suppressed.lead@example.com" });
    const crmCtx = makeCtx(h.db, { now: NOW });
    await addSuppression(crmCtx.tx, crmCtx, { email: p.email!, scope: "newsletter", reason: "unsubscribe", source: "test", personId: p.id });
    const s = await scoreappSource();
    const { key, secret } = parts(s.url);
    const body = scoreappBody();
    body.id = "sa-result-suppressed";
    body.lead.email = "suppressed.lead@example.com";
    await post(key, secret, body);
    const [ev] = await eventsOfSource(s.sourceId);
    expect(await process(ev!.id)).toBe("processed");
    const sub = await subOf(ev!.id);
    expect(sub!.personId).toBe(p.id);
    const granted = await h.db.select().from(consentRecords).where(and(eq(consentRecords.personId, p.id), eq(consentRecords.status, "granted")));
    expect(granted).toHaveLength(0);
    expect(sub!.consentSnapshot).toEqual([{ purpose: "newsletter", granted: false, wordingVersion: "legacy-import", fieldKey: "import:newsletter" }]);
  });

  it("I4: a payload without a valid email is skipped with the reason and creates nothing", async () => {
    const s = await scoreappSource();
    const { key, secret } = parts(s.url);
    const body = scoreappBody();
    body.id = "sa-no-email";
    body.lead.email = "not an email";
    await post(key, secret, body);
    const [ev] = await eventsOfSource(s.sourceId);
    expect(await process(ev!.id)).toBe("skipped");
    const [after] = await h.db.select().from(formImportEvents).where(eq(formImportEvents.id, ev!.id));
    expect(after).toMatchObject({ status: "skipped", error: "missing_email", submissionId: null });
    expect(await subOf(ev!.id)).toBeUndefined();
  });

  it("reprocessing a skipped event requeues it under a fresh key; a processed event is refused", async () => {
    const s = await scoreappSource();
    const { key, secret } = parts(s.url);
    const body = scoreappBody();
    body.id = "sa-reprocess";
    body.lead.email = "";
    await post(key, secret, body);
    const [ev] = await eventsOfSource(s.sourceId);
    await process(ev!.id);
    const r = await imp.reprocessImportEvent(h.db as never, staffCtx(), ev!.id);
    const all = await jobsOf(ev!.id);
    expect(all.map((j) => j.idempotencyKey).sort()).toEqual([`form_import:${ev!.id}`, `form_import:${ev!.id}:reprocess:1`]);
    expect(all.some((j) => j.id === r.jobId)).toBe(true);
    const [again] = await h.db.select().from(formImportEvents).where(eq(formImportEvents.id, ev!.id));
    expect(again!.status).toBe("received");
    // A second reprocess while it waits is refused (it is `received`, not skipped).
    await expect(imp.reprocessImportEvent(h.db as never, staffCtx(), ev!.id)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("I5: CSV backfill", () => {
  it("I5: each row becomes an event; the same CSV uploaded twice only counts duplicates", async () => {
    const s = await scoreappSource();
    const csv = fixture("scoreapp.csv");
    expect(await imp.ingestCsv(h.db as never, staffCtx(), s.sourceId, csv)).toEqual({ inserted: 3, duplicates: 0 });
    expect(await imp.ingestCsv(h.db as never, staffCtx(), s.sourceId, csv)).toEqual({ inserted: 0, duplicates: 3 });
    const events = await eventsOfSource(s.sourceId);
    expect(events).toHaveLength(3);
    for (const e of events) expect(e.externalId).toMatch(/^[0-9a-f]{64}$/);
    const jobRows = await h.db.select().from(jobs).where(inArray(jobs.idempotencyKey, events.map((e) => `form_import:${e.id}`)));
    expect(jobRows).toHaveLength(3);

    const results: Record<string, string> = {};
    for (const e of events) results[(e.payload as { id: string }).id] = await process(e.id);
    expect(results).toEqual({ "sa-csv-2001": "processed", "sa-csv-2002": "processed", "sa-csv-2003": "skipped" });
    const one = await personByEmail("csv.one@example.com");
    const two = await personByEmail("csv.two@example.com");
    // Literal `true` grants; the cell "yes" does not.
    expect(await h.db.select().from(consentRecords).where(eq(consentRecords.personId, one!.id))).toHaveLength(1);
    expect(await h.db.select().from(consentRecords).where(eq(consentRecords.personId, two!.id))).toHaveLength(0);
    const sub = (await h.db.select().from(formSubmissions).where(eq(formSubmissions.personId, two!.id)))[0];
    expect(sub).toMatchObject({ outcomeKey: "thriving", externalRef: "sa-csv-2002", locale: "fr-BE" });
  });

  it("I5: a CSV above 5,000 rows or 2 MB is refused", async () => {
    const s = await scoreappSource();
    const rows = Array.from({ length: imp.IMPORT_CSV_MAX_ROWS + 1 }, (_, n) => `r${n},x${n}@example.com`).join("\n");
    await expect(imp.ingestCsv(h.db as never, staffCtx(), s.sourceId, `id,lead.email\n${rows}`)).rejects.toMatchObject({ code: "validation", message: "csv_too_many_rows" });
    await expect(imp.ingestCsv(h.db as never, staffCtx(), s.sourceId, "a".repeat(imp.IMPORT_CSV_MAX_BYTES + 1))).rejects.toMatchObject({ message: "csv_too_large" });
  });

  it("a result received by webhook and again in the CSV backfill is one submission", async () => {
    const s = await scoreappSource();
    const { key, secret } = parts(s.url);
    const body = scoreappBody();
    body.id = "sa-csv-2001";
    body.lead.email = "csv.dup@example.com";
    await post(key, secret, body);
    const [hook] = await eventsOfSource(s.sourceId);
    expect(await process(hook!.id)).toBe("processed");
    await imp.ingestCsv(h.db as never, staffCtx(), s.sourceId, "id,lead.email\nsa-csv-2001,csv.dup@example.com\n");
    const csvEvent = (await eventsOfSource(s.sourceId)).find((e) => e.id !== hook!.id)!;
    expect(await process(csvEvent.id)).toBe("skipped");
    const [after] = await h.db.select().from(formImportEvents).where(eq(formImportEvents.id, csvEvent.id));
    expect(after!.error).toBe("duplicate_result");
  });
});

describe("queries: listImportSources, getImportSource, listImportEvents", () => {
  it("counts per status, masks the secret and pages the events newest first", async () => {
    const { getImportSource, listImportEvents, listImportSources } = await import("../queries");
    const s = await scoreappSource();
    const csv = ["id,lead.email", ...Array.from({ length: 3 }, (_, n) => `q-${n},q${n}@example.com`), "q-x,"].join("\n");
    await imp.ingestCsv(h.db as never, staffCtx(), s.sourceId, csv);
    for (const e of await eventsOfSource(s.sourceId)) await process(e.id);

    const row = (await listImportSources(h.db)).find((r) => r.id === s.sourceId);
    expect(row).toMatchObject({ provider: "scoreapp", formId: s.formId, formSlug: `import-${s.key}`, isActive: true, counts: { received: 0, processed: 3, skipped: 1, failed: 0 } });
    const detail = await getImportSource(h.db, s.sourceId);
    const { secret } = parts(s.url);
    expect(detail!.maskedUrl).toContain(`/api/public/forms/import/${s.key}/`);
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(detail).not.toHaveProperty("tokenHash");
    expect(detail!.mapping?.email).toBe("lead.email");

    const skipped = await listImportEvents(h.db, { sourceId: s.sourceId, status: "skipped" });
    expect(skipped.rows.map((r) => r.error)).toEqual(["missing_email"]);
    expect(skipped.rows[0]).not.toHaveProperty("payload");
    const all = await listImportEvents(h.db, { sourceId: s.sourceId });
    expect(all.rows).toHaveLength(4);
    expect(all.nextCursor).toBeNull();
  });
});

/** forms-P3: sensitive answers (rules SE1 to SE3, S6). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, auditLog, formSensitiveAnswers, formSubmissions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { and, eq } from "@/lib/ctx";
import { decryptSensitive, sensitiveAad } from "@/lib/sensitive";
import { makeCtx, resetRuntime, staffActor } from "@/lib/testing";
import { assessment, ASSESSMENT_ANSWERS, createForm, later, publicCtx, setupEnv } from "../forms-p3.fixtures";
import { readSubmissionAnswers } from "./sensitive";
import { completeSubmission, saveSection, startSubmission } from "./submissions";

let h: DbHandle;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const T0 = new Date("2026-11-04T09:00:00Z");
const SENSITIVE_VALUES = ["5_6", "stress_physical"];

async function begin() {
  const f = await createForm(h.db, assessment());
  const ctx = publicCtx(h.db, T0);
  const s = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "en", url: "https://app.example.com/en/f/x", ip: "203.0.113.5" });
  return { f, s };
}

async function completed() {
  const { f, s } = await begin();
  const ctx = publicCtx(h.db, later(T0, 30));
  await completeSubmission(ctx.tx, ctx, {
    submissionId: s.submissionId,
    proof: { resumeToken: s.resumeToken! },
    answers: { ...ASSESSMENT_ANSWERS, email: `sens-${randomUUID().slice(0, 8)}@example.com` } as never,
    ip: "203.0.113.5",
    userAgent: "vitest",
  });
  const [sub] = await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, s.submissionId));
  return { f, s, sub: sub! };
}

const rowsOf = (submissionId: string) => h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, submissionId));

describe("SE1, S6: sensitive values only in form_sensitive_answers", () => {
  it("keeps sensitive keys out of answers, score and event data; dimensions stored as score:<key>", async () => {
    const { sub } = await completed();
    for (const k of ["sleep_hours", "sleep_quality", "stress_level", "stress_physical"]) expect(sub.answers).not.toHaveProperty(k);
    expect(Object.keys(sub.score!.dimensions)).toEqual(["habits"]);
    const rows = await rowsOf(sub.id);
    expect(rows.map((r) => r.fieldKey).sort()).toEqual(["score:sleep", "score:stress", "sleep_hours", "sleep_quality", "stress_level", "stress_physical"]);
    expect(rows.every((r) => r.personId === sub.personId && r.keyVersion === 1)).toBe(true);
    for (const r of rows) expect(Buffer.from(r.valueEnc).toString("utf8")).not.toContain("5_6");
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.refType, "form_submission"), eq(activityEvents.refId, sub.id)));
    for (const e of events) {
      const json = JSON.stringify(e.data);
      for (const v of SENSITIVE_VALUES) expect(json).not.toContain(v);
      expect(json).not.toMatch(/"sleep"|"stress"/);
    }
  });

  it("the AAD binds a value to its submission and key: another AAD fails to decrypt", async () => {
    const { sub } = await completed();
    const [r] = (await rowsOf(sub.id)).filter((x) => x.fieldKey === "sleep_hours");
    expect(JSON.parse(decryptSensitive(r!.valueEnc, r!.keyVersion, sensitiveAad.formAnswer(sub.id, "sleep_hours")))).toBe("5_6");
    expect(() => decryptSensitive(r!.valueEnc, r!.keyVersion, sensitiveAad.formAnswer(sub.id, "stress_level"))).toThrow(/decrypt_failed/);
    expect(() => decryptSensitive(r!.valueEnc, r!.keyVersion, sensitiveAad.formAnswer(randomUUID(), "sleep_hours"))).toThrow(/decrypt_failed/);
  });
});

describe("SE2: discarded before consent", () => {
  it("a save of sensitive answers without the sensitive_processing consent stores nothing; with it they are stored", async () => {
    const { s } = await begin();
    const ctx = publicCtx(h.db, later(T0, 5));
    const proof = { resumeToken: s.resumeToken! };
    const body = { sleep_hours: "lt5", sleep_quality: 1, stress_level: 3 };
    await saveSection(ctx.tx, ctx, { submissionId: s.submissionId, proof, sectionKey: "sleep_stress", answers: body });
    expect(await rowsOf(s.submissionId)).toHaveLength(0);
    const [sub] = await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, s.submissionId));
    expect(sub!.answers).not.toHaveProperty("sleep_hours");

    await saveSection(ctx.tx, ctx, { submissionId: s.submissionId, proof, sectionKey: "about", answers: { email: "se2@example.com", first_name: "Sam", sensitive_consent: true } });
    await saveSection(ctx.tx, ctx, { submissionId: s.submissionId, proof, sectionKey: "sleep_stress", answers: body });
    expect((await rowsOf(s.submissionId)).map((r) => r.fieldKey).sort()).toEqual(["sleep_hours", "sleep_quality", "stress_level"]);
  });

  it("submit without the consent fails validation and writes nothing sensitive", async () => {
    const { s } = await begin();
    const ctx = publicCtx(h.db, later(T0, 30));
    await expect(
      completeSubmission(ctx.tx, ctx, { submissionId: s.submissionId, proof: { resumeToken: s.resumeToken! }, answers: { ...ASSESSMENT_ANSWERS, sensitive_consent: false, email: "nocons@example.com" } as never, ip: "203.0.113.5", userAgent: "t" }),
    ).rejects.toMatchObject({ code: "validation", fields: { sensitive_consent: "required" } });
    expect(await rowsOf(s.submissionId)).toHaveLength(0);
  });
});

describe("SE3: decryption only through readSensitive with platform's purposes", () => {
  const audits = (personId: string) => h.db.select().from(auditLog).where(and(eq(auditLog.action, "sensitive.read"), eq(auditLog.personId, personId)));

  it("staff_view needs persons.sensitive_read; values come from SensitiveBundle.formAnswers and the audit holds keys only", async () => {
    const { sub } = await completed();
    const denied = makeCtx(h.db, staffActor({ permissions: ["forms.write"] }));
    await expect(readSubmissionAnswers(denied, sub.personId!, "staff_view", [sub.id])).rejects.toThrow(/persons\.sensitive_read/);
    const staff = makeCtx(h.db, staffActor({ permissions: ["persons.sensitive_read"] }));
    const answers = await readSubmissionAnswers(staff, sub.personId!, "staff_view", [sub.id]);
    expect(answers.find((a) => a.fieldKey === "sleep_hours")?.value).toBe("5_6");
    expect(answers.find((a) => a.fieldKey === "stress_physical")?.value).toBe(true);
    expect(answers.find((a) => a.fieldKey === "score:sleep")?.value).toMatchObject({ value: 5, rangeKey: "fair" });
    const [audit] = await audits(sub.personId!);
    expect(audit!.newValue).toMatchObject({ purpose: "staff_view", submission_ids: [sub.id] });
    expect(JSON.stringify(audit)).not.toContain("5_6");
  });

  it("subject_result (system actor, own submissions) and privacy_export read the same values", async () => {
    const { sub } = await completed();
    const system = makeCtx(h.db);
    const own = await readSubmissionAnswers(system, sub.personId!, "subject_result", [sub.id]);
    expect(own.map((a) => a.fieldKey)).toContain("sleep_hours");
    const other = await completed();
    await expect(readSubmissionAnswers(system, sub.personId!, "subject_result", [other.sub.id])).rejects.toThrow(/another person/);
    const all = await readSubmissionAnswers(system, sub.personId!, "privacy_export");
    expect(all.length).toBe(own.length);
    expect((await audits(sub.personId!)).map((a) => (a.newValue as { purpose: string }).purpose).sort()).toEqual(["privacy_export", "subject_result"]);
  });
});

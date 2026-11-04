/** forms-P3: GDPR export, erase and merge (forms spec section 9, scenario 7). */
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, formImportEvents, formImportSources, formLinks, formSensitiveAnswers, formSubmissions, orders } from "@beam/db/schema";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { and, eq, or, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { resetRuntime } from "@/lib/testing";
import { assessment, ASSESSMENT_ANSWERS, createForm, later, publicCtx, setupEnv } from "./forms-p3.fixtures";
import { formsPrivacy, privacy } from "./privacy";
import { getResultByToken } from "./service/public-queries";
import { completeSubmission, startSubmission } from "./service/submissions";

let h: DbHandle;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const T0 = new Date("2026-10-04T09:00:00Z");

async function completedFor(address: string) {
  const f = await createForm(h.db, assessment());
  const ctx = publicCtx(h.db, T0);
  const s = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "en", url: "https://app.example.com/en/f/x", ip: "203.0.113.4" });
  const c = publicCtx(h.db, later(T0, 30));
  const r = await completeSubmission(c.tx, c, { submissionId: s.submissionId, proof: { resumeToken: s.resumeToken! }, answers: { ...ASSESSMENT_ANSWERS, email: address }, ip: "203.0.113.4", userAgent: "t" });
  const [sub] = await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, s.submissionId));
  return { f, sub: sub!, resultUrl: r.resultUrl! };
}

const sha = (s: string) => createHash("sha256").update(s.toLowerCase()).digest("hex");

describe("export", () => {
  it("lists submissions with labels and the sensitive answers decrypted through privacy_export", async () => {
    const address = `export-${randomUUID().slice(0, 6)}@example.com`;
    const { sub, f } = await completedFor(address);
    const out = (await h.db.transaction((tx) => privacy.export(tx, sub.personId!))) as {
      form_submissions: { submission_id: string; form_slug: string; answers: { key: string; label: string }[]; outcome: { key: string } | null; entered_by_staff: boolean }[];
      form_sensitive_answers: { key: string; label: string; value: unknown }[];
    };
    expect(out.form_submissions).toHaveLength(1);
    expect(out.form_submissions[0]).toMatchObject({ submission_id: sub.id, form_slug: f.slug, outcome: { key: "reset_now" }, entered_by_staff: false });
    expect(out.form_submissions[0]!.answers.find((a) => a.key === "movement")?.label).toBe("How often do you exercise for at least 30 minutes?");
    const sleep = out.form_sensitive_answers.find((a) => a.key === "sleep_hours");
    expect(sleep).toMatchObject({ value: "5_6", label: "How many hours do you sleep on average per night?" });
    expect(out.form_sensitive_answers.find((a) => a.key === "score:sleep")?.label).toBe("Sleep");
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "sensitive.read"), eq(auditLog.personId, sub.personId!)));
    expect(audits.map((a) => (a.newValue as { purpose: string }).purpose)).toEqual(["privacy_export"]);
    expect(formsPrivacy).toBe(privacy);
  });
});

describe("erase", () => {
  it("leaves no forms row referencing the person or their email hash, nulls referral links, keeps other modules' rows", async () => {
    const address = `erase-${randomUUID().slice(0, 6)}@example.com`;
    const { sub, f } = await completedFor(address);
    const personId = sub.personId!;
    await completedFor(address);
    const order = await makeOrder(h.db, { personId, status: "paid" });
    const u = await makeUser(h.db);
    const [link] = await h.db.insert(formLinks).values({ formId: f.formId, key: "ref00001", name: "Referral", channel: "referral", referrerPersonId: personId, createdByUserId: u.id }).returning();
    const [src] = await h.db
      .insert(formImportSources)
      .values({ key: "erase0000001", provider: "typeform", name: "Typeform", formId: f.formId, tokenHash: "d".repeat(64), mapping: {}, createdByUserId: u.id })
      .returning();
    await h.db.insert(formImportEvents).values([
      { sourceId: src!.id, externalId: "by-hash", payload: { email: address }, emailHash: sha(address) },
      { sourceId: src!.id, externalId: "by-submission", payload: {}, submissionId: sub.id },
      { sourceId: src!.id, externalId: "someone-else", payload: {}, emailHash: sha("other@example.com") },
    ]);

    const report = await h.db.transaction((tx) => privacy.erase(tx, personId));
    expect(Object.fromEntries(report.map((r) => [r.table, r.rows]))).toMatchObject({ form_submissions: 2, form_import_events: 2, form_links: 1 });
    expect(await h.db.select().from(formSubmissions).where(eq(formSubmissions.personId, personId))).toHaveLength(0);
    expect(await h.db.select().from(formSensitiveAnswers).where(or(eq(formSensitiveAnswers.personId, personId), eq(formSensitiveAnswers.submissionId, sub.id)))).toHaveLength(0);
    expect(await h.db.select().from(formImportEvents).where(or(eq(formImportEvents.emailHash, sha(address)), eq(formImportEvents.submissionId, sub.id)))).toHaveLength(0);
    expect((await h.db.select().from(formImportEvents).where(eq(formImportEvents.sourceId, src!.id))).map((e) => e.externalId)).toEqual(["someone-else"]);
    const [l] = await h.db.select().from(formLinks).where(eq(formLinks.id, link!.id));
    expect(l!.referrerPersonId).toBeNull();
    expect(await h.db.select().from(orders).where(eq(orders.id, order.id))).toHaveLength(1);
  });
});

describe("merge", () => {
  it("crm's information_schema repoint moves forms rows to the winner and result tokens keep working", async () => {
    const address = `merge-${randomUUID().slice(0, 6)}@example.com`;
    const { sub, resultUrl } = await completedFor(address);
    const winner = await makePerson(h.db);
    const loser = sub.personId!;
    // What crm rule 3.30 does: every `*person_id` column of a forms table that references persons.
    const cols = rowsOf<{ table_name: string; column_name: string }>(
      await h.db.execute(sql`
        select kcu.table_name, kcu.column_name from information_schema.referential_constraints rc
        join information_schema.key_column_usage kcu on kcu.constraint_name = rc.constraint_name
        join information_schema.constraint_column_usage ccu on ccu.constraint_name = rc.unique_constraint_name
        where ccu.table_name = 'persons' and kcu.table_name like 'form%'`),
    );
    expect(cols.map((c) => `${c.table_name}.${c.column_name}`).sort()).toEqual(["form_links.referrer_person_id", "form_sensitive_answers.person_id", "form_submissions.person_id"]);
    for (const c of cols) await h.db.execute(sql.raw(`update ${c.table_name} set ${c.column_name} = '${winner.id}' where ${c.column_name} = '${loser}'`));
    const token = resultUrl.split("/r/")[1]!;
    const result = await getResultByToken(h.db, token);
    expect(result).toMatchObject({ submissionId: sub.id, personId: winner.id });
    const sens = await h.db.select().from(formSensitiveAnswers).where(eq(formSensitiveAnswers.submissionId, sub.id));
    expect(sens.every((r) => r.personId === winner.id)).toBe(true);
  });
});

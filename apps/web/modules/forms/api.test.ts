/** forms-P3: the cross-module api (forms spec section 4 "Cross-module API"). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { forms, formImportEvents, formImportSources } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { enqueue } from "@beam/db";
import { eq, sql } from "@/lib/ctx";
import { rowsOf } from "@/lib/sensitive";
import { resetRuntime } from "@/lib/testing";
import {
  buildFormUrl,
  createPersonToken,
  getFormsHealth,
  getLatestOutcomes,
  getPublishedFormMeta,
  hasValidSubmission,
  listLatestOutcomes,
  listOutcomes,
  listPersonSubmissions,
  listPublishedForms,
  verifyPersonToken,
} from "./api";
import { assessment, ASSESSMENT_ANSWERS, createForm, later, lead, publicCtx, setupEnv } from "./forms-p3.fixtures";
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

const DAY = "2026-07-15";
const T0 = new Date("2026-07-15T10:00:00Z");

async function complete(slug: string, address: string, answers: Record<string, unknown> = ASSESSMENT_ANSWERS, at = T0) {
  const ctx = publicCtx(h.db, at);
  const s = await startSubmission(ctx.tx, ctx, { slug, locale: "en", url: "https://app.example.com/en/f/x", ip: "203.0.113.6" });
  const c = publicCtx(h.db, later(at, 30));
  await completeSubmission(c.tx, c, { submissionId: s.submissionId, proof: { resumeToken: s.resumeToken! }, answers: { ...answers, email: address }, ip: "203.0.113.6", userAgent: "t" });
  return s.submissionId;
}

const personOf = async (_slug: string, address: string) => rowsOf<{ id: string }>(await h.db.execute(sql`select id from persons where email = ${address}`))[0]!.id;

describe("forms api", () => {
  it("getLatestOutcomes and listLatestOutcomes (also inside a transaction)", async () => {
    const f = await createForm(h.db, assessment());
    const a = `latest-a-${randomUUID().slice(0, 6)}@example.com`;
    const b = `latest-b-${randomUUID().slice(0, 6)}@example.com`;
    await complete(f.slug, a);
    await complete(f.slug, a, { ...ASSESSMENT_ANSWERS, movement: "daily", cold_exposure: true }, later(T0, 3600));
    await complete(f.slug, b);
    const pa = await personOf(f.slug, a);
    const pb = await personOf(f.slug, b);
    const latest = await getLatestOutcomes(h.db, [pa, pb, randomUUID()]);
    expect(latest.get(pa)).toEqual([expect.objectContaining({ formSlug: f.slug, outcomeKey: "keep_going", totalScore: 40 })]);
    expect(latest.get(pb)![0]!.outcomeKey).toBe("reset_now");
    expect(latest.size).toBe(2);
    expect(await listLatestOutcomes(h.db, [pa, pb], f.slug)).toEqual(new Map([[pa, "keep_going"], [pb, "reset_now"]]));
    const inTx = await h.db.transaction((tx) => listLatestOutcomes(tx, [pa], f.slug));
    expect(inTx.get(pa)).toBe("keep_going");
    expect(await listLatestOutcomes(h.db, [], f.slug)).toEqual(new Map());
  });

  it("listPersonSubmissions has no answer values", async () => {
    const f = await createForm(h.db, assessment());
    const addr = `subs-${randomUUID().slice(0, 6)}@example.com`;
    const id = await complete(f.slug, addr);
    const list = await listPersonSubmissions(h.db, await personOf(f.slug, addr));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ submissionId: id, formSlug: f.slug, version: 1, status: "completed", outcomeKey: "reset_now", outcomeLabel: { en: "Time for a reset" }, hasSensitive: true });
    expect(Object.keys(list[0]!)).not.toContain("answers");
    const json = JSON.stringify(list);
    for (const v of ["5_6", "gt5", "rarely", "Lotte"]) expect(json).not.toContain(v);
  });

  it("getPublishedFormMeta, listPublishedForms and listOutcomes; null for archived", async () => {
    const f = await createForm(h.db, assessment());
    expect(await getPublishedFormMeta(h.db, f.slug)).toEqual({ formId: f.formId, locales: ["nl-BE", "fr-BE", "en"] });
    expect((await listPublishedForms(h.db)).map((r) => r.slug)).toContain(f.slug);
    expect((await listOutcomes(h.db, f.slug)).map((o) => o.key)).toEqual(["reset_now", "build_routine", "keep_going", "recovery_pro"]);
    await h.db.update(forms).set({ status: "archived", archivedAt: new Date() }).where(eq(forms.id, f.formId));
    expect(await getPublishedFormMeta(h.db, f.slug)).toBeNull();
    expect((await listPublishedForms(h.db)).map((r) => r.slug)).not.toContain(f.slug);
    expect(await getPublishedFormMeta(h.db, "no-such-form")).toBeNull();
  });

  it("hasValidSubmission through the api", async () => {
    const f = await createForm(h.db, lead({ validityDays: 365 }));
    expect(await hasValidSubmission(h.db, { personId: randomUUID(), formSlug: f.slug })).toEqual({ valid: false, completedAt: null, expiresAt: null });
    expect(await hasValidSubmission(h.db, { personId: randomUUID(), formSlug: "health-declaration-missing" })).toMatchObject({ valid: false });
  });

  it("createPersonToken, verifyPersonToken and buildFormUrl", () => {
    const personId = randomUUID();
    const t = createPersonToken(personId, { formSlug: "contact", ttlDays: 1 });
    const v = verifyPersonToken(t)!;
    expect(v).toMatchObject({ personId, formSlug: "contact", staffUserId: null });
    expect(v.expiresAt.getTime() - Date.now()).toBeGreaterThan(86_000_000);
    expect(verifyPersonToken(`${t}x`)).toBeNull();
    const url = new URL(buildFormUrl({ slug: "contact", locale: "fr-BE", personId, src: "webinar", utm: { campaign: "sleep", medium: "email" }, linkKey: "abcd1234" }));
    expect(url.origin + url.pathname).toBe("https://app.example.com/fr/f/contact");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ src: "webinar", utm_campaign: "sleep", utm_medium: "email", l: "abcd1234" });
    expect(verifyPersonToken(url.searchParams.get("pt")!)?.personId).toBe(personId);
    expect(new URL(buildFormUrl({ slug: "contact", locale: "en" })).search).toBe("");
  });

  it("getFormsHealth counts one Brussels day", async () => {
    const before = await getFormsHealth(h.db, { day: DAY });
    const f = await createForm(h.db, assessment());
    await complete(f.slug, `health-${randomUUID().slice(0, 6)}@example.com`);
    const ctx = publicCtx(h.db, T0);
    await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "en", url: "https://app.example.com/en/f/x", ip: "203.0.113.7" });
    const u = await makeUser(h.db);
    const [src] = await h.db.insert(formImportSources).values({ key: "health000001", provider: "scoreapp", name: "S", formId: f.formId, tokenHash: "e".repeat(64), mapping: {}, createdByUserId: u.id }).returning();
    await h.db.insert(formImportEvents).values([
      { sourceId: src!.id, externalId: "f1", payload: {}, status: "failed", receivedAt: T0 },
      { sourceId: src!.id, externalId: "s1", payload: {}, status: "skipped", receivedAt: T0 },
      { sourceId: src!.id, externalId: "s2", payload: {}, status: "skipped", receivedAt: new Date("2026-07-16T12:00:00Z") },
    ]);
    const job = await enqueue(h.db, { kind: "forms.check_cta_targets", payload: {}, key: `test:dead:${randomUUID()}` });
    await h.db.execute(sql`update jobs set status = 'dead', updated_at = ${T0.toISOString()}::timestamptz where id = ${job.id}`);
    await h.db.update(forms).set({ ctaWarnings: [{ endingKey: "result_reset", ctaKey: "book", reason: "inactive_template" }] }).where(eq(forms.id, f.formId));
    const after = await getFormsHealth(h.db, { day: DAY });
    expect({
      completions: after.completions - before.completions,
      started: after.started - before.started,
      importFailed: after.importFailed - before.importFailed,
      importSkipped: after.importSkipped - before.importSkipped,
      deadJobs: after.deadJobs - before.deadJobs,
      formsWithBrokenCtas: after.formsWithBrokenCtas - before.formsWithBrokenCtas,
    }).toEqual({ completions: 1, started: 2, importFailed: 1, importSkipped: 1, deadJobs: 1, formsWithBrokenCtas: 1 });
    await expect(getFormsHealth(h.db, { day: "15/07/2026" })).rejects.toThrow(RangeError);
  });
});

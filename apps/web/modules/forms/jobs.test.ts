/** forms-P3: every forms job runs twice with the same payload and leaves the same state (conventions, runJobTwice). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { activityEvents, emailMessages, forms, formSubmissions, jobs as jobsTable, products } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import { and, eq, inArray, sql } from "@/lib/ctx";
import { resetRuntime, runJobTwice } from "@/lib/testing";
import { assessment, ASSESSMENT_ANSWERS, createForm, later, lead, publicCtx, setupEnv, T } from "./forms-p3.fixtures";
import { abandonMinute, ABANDON_BATCH, jobs } from "./jobs";
import { schedules } from "./schedules";
import { completeSubmission, startSubmission } from "./service/submissions";
import { createIdentityToken, createResultToken, hashToken } from "./service/tokens";

let h: DbHandle;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const OLD = new Date("2020-03-01T08:00:00Z");

describe("job declarations", () => {
  it("declares the three forms-P3 kinds with the spec's lanes and the two schedules", () => {
    const byKind = Object.fromEntries(jobs.map((j) => [j.kind, j]));
    expect(byKind["forms.mark_abandoned"]).toMatchObject({ lane: "fast", priority: 5, maxAttempts: 6 });
    expect(byKind["forms.send_result_link"]).toMatchObject({ lane: "fast", priority: 1, maxAttempts: 6 });
    expect(byKind["forms.check_cta_targets"]).toMatchObject({ lane: "bulk", priority: 9, maxAttempts: 3 });
    expect(schedules.map((s) => [s.kind, s.cron])).toEqual([
      ["forms.mark_abandoned", "*/10 * * * *"],
      ["forms.check_cta_targets", "50 2 * * *"],
    ]);
    expect(abandonMinute("schedule:forms.mark_abandoned:2026-11-04T10:20", new Date())).toBe("2026-11-04T10:20");
    expect(abandonMinute("other", new Date("2026-11-04T09:20:00Z"))).toBe("2026-11-04T10:20");
  });
});

describe("runJobTwice", () => {
  it("forms.mark_abandoned", async () => {
    const f = await createForm(h.db, lead());
    const p = await makePerson(h.db);
    const ctx = publicCtx(h.db, OLD);
    const a = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "nl-BE", url: "https://app.example.com/nl/f/x", ip: "203.0.113.1" });
    const b = await startSubmission(ctx.tx, ctx, {
      slug: f.slug,
      locale: "nl-BE",
      url: "https://app.example.com/nl/f/x",
      ip: "203.0.113.1",
      identityToken: createIdentityToken({ personId: p.id, ttlSeconds: 3600, now: OLD }),
    });
    const state = async () => ({
      subs: (await h.db.select({ id: formSubmissions.id, status: formSubmissions.status, abandonedAt: formSubmissions.abandonedAt }).from(formSubmissions).where(inArray(formSubmissions.id, [a.submissionId, b.submissionId]))).sort((x, y) => x.id.localeCompare(y.id)),
      events: (await h.db.select({ kind: activityEvents.kind }).from(activityEvents).where(eq(activityEvents.refId, b.submissionId))).map((e) => e.kind).sort(),
    });
    let afterFirst: Awaited<ReturnType<typeof state>> | undefined;
    const r = await runJobTwice(h.db, "forms.mark_abandoned", {}, { between: async () => void (afterFirst = await state()) });
    expect((r.first as { abandoned: number }).abandoned).toBeGreaterThanOrEqual(2);
    expect(r.second).toEqual({ abandoned: 0 });
    const after = await state();
    expect(after).toEqual(afterFirst);
    expect(after.subs.every((s) => s.status === "abandoned")).toBe(true);
    expect(after.events).toEqual(["form.abandoned", "form.started"]);
    expect(ABANDON_BATCH).toBe(1000);
  });

  it("forms.send_result_link renews an expired link once and queues one email", async () => {
    const f = await createForm(h.db, assessment());
    const ctx = publicCtx(h.db, OLD);
    const s = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "en", url: "https://app.example.com/en/f/x", ip: "203.0.113.2" });
    const sub = publicCtx(h.db, later(OLD, 60));
    await completeSubmission(sub.tx, sub, { submissionId: s.submissionId, proof: { resumeToken: s.resumeToken! }, answers: { ...ASSESSMENT_ANSWERS, email: `link-${randomUUID().slice(0, 6)}@example.com` } as never, ip: "203.0.113.2", userAgent: "t" });
    const read = async () => (await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, s.submissionId)))[0]!;
    expect((await read()).resultTokenExpiresAt!.getTime()).toBeLessThan(Date.now());
    let firstVersion = 0;
    const r = await runJobTwice(h.db, "forms.send_result_link", { submissionId: s.submissionId, locale: "en" }, { between: async () => void (firstVersion = (await read()).resultTokenVersion) });
    const row = await read();
    expect(row.resultTokenVersion).toBe(2);
    expect(firstVersion).toBe(2);
    expect(row.resultTokenHash).toBe(hashToken(createResultToken(s.submissionId, 2)));
    expect(row.resultTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(r.first).toEqual(r.second);
    const msgs = await h.db.select().from(emailMessages).where(sql`${emailMessages.idempotencyKey} like ${`form_result_link:${s.submissionId}:%`}`);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ kind: "transactional", locale: "en", personId: row.personId });
  });

  it("forms.check_cta_targets overwrites the warnings the same way twice", async () => {
    const a = assessment();
    const product = await makeProduct(h.db);
    await h.db.update(products).set({ isActive: false }).where(eq(products.id, product.id));
    a.definition.endings[1]!.ctas = [{ key: "shop", label: T("Shop"), kind: "product", productId: product.id }];
    const f = await createForm(h.db, a);
    let first: unknown;
    await runJobTwice(h.db, "forms.check_cta_targets", {}, { between: async () => void (first = (await h.db.select().from(forms).where(eq(forms.id, f.formId)))[0]!.ctaWarnings) });
    const [row] = await h.db.select().from(forms).where(eq(forms.id, f.formId));
    expect(row!.ctaWarnings).toEqual([{ endingKey: "result_balance", ctaKey: "shop", reason: "inactive_product" }]);
    expect(row!.ctaWarnings).toEqual(first);
  });

  it("requestResultLink enqueues at most three links per day with the spec's keys", async () => {
    const { requestResultLink } = await import("./service/submissions");
    const f = await createForm(h.db, assessment());
    const addr = `again-${randomUUID().slice(0, 6)}@example.com`;
    const ctx = publicCtx(h.db, OLD);
    const s = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "en", url: "https://app.example.com/en/f/x", ip: "203.0.113.3" });
    const sub = publicCtx(h.db, later(OLD, 60));
    await completeSubmission(sub.tx, sub, { submissionId: s.submissionId, proof: { resumeToken: s.resumeToken! }, answers: { ...ASSESSMENT_ANSWERS, email: addr } as never, ip: "203.0.113.3", userAgent: "t" });
    const now = new Date("2026-11-04T10:00:00Z");
    for (let i = 0; i < 4; i++) {
      const c = publicCtx(h.db, now);
      await requestResultLink(c.tx, c, { slug: f.slug, email: addr.toUpperCase(), locale: "en" }).catch(() => undefined);
    }
    const c = publicCtx(h.db, now);
    expect(await requestResultLink(c.tx, c, { slug: f.slug, email: "unknown@example.com", locale: "en" })).toEqual({ ok: true });
    const queued = await h.db.select({ key: jobsTable.idempotencyKey }).from(jobsTable).where(and(eq(jobsTable.kind, "forms.send_result_link"), sql`${jobsTable.idempotencyKey} like ${`form_result_link:${s.submissionId}:%`}`));
    expect(queued.map((q) => q.key).sort()).toEqual([1, 2, 3].map((n) => `form_result_link:${s.submissionId}:2026-11-04:${n}`));
  });
});

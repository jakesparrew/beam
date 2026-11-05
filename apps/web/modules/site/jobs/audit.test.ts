/**
 * site-P10 `site.audit_content` (site spec sections 4 and 5, decision 22): the weekly Claude content
 * audit. A double run inserts one report per Brussels week and calls Claude no more; findings carry
 * no personal data (testimonial names, emails and phone numbers are neither sent nor stored) and
 * only known pages, locales and codes; a budget refusal leaves no report and ends the run without
 * throwing (no failure loop); broken references and missing locales are found without Claude; the
 * schedule is Monday 07:10; the latest report is read for `/admin/site`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { aiRequests, pages, pageVersions, siteAuditReports } from "@beam/db/schema";
import { createTestDb, makePerson, makeProduct } from "@beam/db/testing";
import type { Block } from "@beam/core/site";
import { paragraphDoc } from "@beam/core/site";
import type { ClaudeRequest } from "@beam/integrations/anthropic";

vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/forms/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPublishedForms: () => Promise.resolve([]),
  getPublishedFormMeta: () => Promise.resolve(null),
}));

const { eq, setAppDb, sql } = await import("@/lib/ctx");
const { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, runJobTwice } = await import("@/lib/testing");
const { getSetting, setSetting } = await import("@/lib/settings");
const { AUDIT_AI_CODES, AUDIT_LOCALE_MISSING, auditContent, auditWeekOn, getLatestAuditReport, maskPersonalData } = await import("./audit");
const { schedules } = await import("../schedules");
const { pageWithRequest } = await import("./site-p4.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

type Issue = { locale: string; severity: "info" | "warn"; code: string; message: string };
/** Fakes whose audit answer is `issues` for every page (or a function of the request). */
function scripted(issues: Issue[] | ((req: ClaudeRequest) => Issue[]) = []) {
  const integrations = createFakeIntegrations();
  integrations.anthropic.script("site.audit_content", (req) => ({ issues: typeof issues === "function" ? issues(req) : issues }));
  return integrations;
}
const auditCalls = (i: ReturnType<typeof createFakeIntegrations>) => i.anthropic.calls.filter((c) => c.input.feature === "site.audit_content");
const reportOf = async (weekOn: string) => (await h.db.select().from(siteAuditReports).where(eq(siteAuditReports.weekOn, weekOn)))[0] ?? null;
/** A Monday noon of week `n` from 2027 on (each test uses its own weeks; "now" is pinned). */
const week = (n: number) => new Date(Date.UTC(2027, 0, 4 + 7 * n, 11, 0));
const run = (now: Date, integrations: ReturnType<typeof createFakeIntegrations>, attempt = 1) =>
  auditContent(makeJobCtx(h.db, "site.audit_content", { integrations, attempt, now }), {});

describe("auditWeekOn", () => {
  it("is the Monday of the Brussels week, across midnight and DST", () => {
    expect(auditWeekOn(new Date("2026-11-01T22:30:00Z"))).toBe("2026-10-26"); // Sunday 23:30 CET
    expect(auditWeekOn(new Date("2026-11-01T23:30:00Z"))).toBe("2026-11-02"); // Monday 00:30 CET
    expect(auditWeekOn(new Date("2026-03-29T21:59:00Z"))).toBe("2026-03-23"); // Sunday 23:59 CEST
    expect(auditWeekOn(new Date("2026-03-29T22:00:00Z"))).toBe("2026-03-30"); // Monday 00:00 CEST
    expect(auditWeekOn(week(0))).toBe("2027-01-04");
  });

  it("the schedule runs every Monday at 07:10", () => {
    expect(schedules).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "site.audit_content", cron: "10 7 * * 1" })]));
  });
});

describe("site.audit_content", () => {
  it("a double run inserts one report for the week and calls Claude only in the first run", async () => {
    await pageWithRequest(h.db);
    const integrations = scripted([{ locale: "en", severity: "warn", code: "seo_description_weak", message: "Say what the visitor gets." }]);
    const { first, second } = await runJobTwice(h.db, "site.audit_content", {}, { integrations });
    expect(first).toMatchObject({ outcome: "reported" });
    const weekOn = (first as { weekOn: string }).weekOn;
    expect(second).toEqual({ outcome: "skipped", weekOn, reason: "already_reported" });
    const rows = await h.db.select().from(siteAuditReports).where(eq(siteAuditReports.weekOn, weekOn));
    expect(rows).toHaveLength(1);
    const pagesAudited = (first as { pages: number }).pages;
    expect(auditCalls(integrations)).toHaveLength(pagesAudited);
    expect(rows[0]!.findings.some((f) => f.code === "seo_description_weak" && f.locale === "en")).toBe(true);
    expect(rows[0]!.aiRequestId).toBeTruthy();
    const [ai] = await h.db.select().from(aiRequests).where(eq(aiRequests.id, rows[0]!.aiRequestId!));
    expect(ai).toMatchObject({ feature: "site.audit_content", model: "claude-haiku-5-5", status: "ok", fieldsSent: [] });
  });

  it("findings never include personal data, unknown locales or unknown codes", async () => {
    const f = await pageWithRequest(h.db, { locales: ["nl-BE", "en"] });
    await makePerson(h.db, { firstName: "Griet", lastName: "Verhaegen", email: "griet.verhaegen@example.com" });
    const testimonial: Block = { id: randomUUID(), type: "testimonial", quote: "Heerlijke sauna.", authorName: "Marie Dubois", authorDetail: "Lid sinds 2020", consentConfirmed: true };
    const contact: Block = { id: randomUUID(), type: "rich_text", doc: paragraphDoc("Mail marie.dubois@example.com of bel +32 470 12 34 56.") };
    const [live] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, f.liveId));
    await h.db
      .update(pageVersions)
      .set({ blocks: { "nl-BE": [...live!.blocks["nl-BE"]!, testimonial, contact], en: live!.blocks.en! } })
      .where(eq(pageVersions.id, f.liveId));
    const integrations = scripted((req) =>
      req.messages[0]!.content.includes(f.pageId) || req.messages[0]!.content.includes("Heerlijke sauna")
        ? [
            { locale: "nl-BE", severity: "warn", code: "content_thin", message: "Ask Marie Dubois (marie.dubois@example.com, +32 470 12 34 56) for a longer quote." },
            { locale: "fr-BE", severity: "info", code: "seo_title_weak", message: "The page has no French title." },
            { locale: "en", severity: "info", code: "made_up_code", message: "Mention the opening hours." },
          ]
        : [],
    );
    const now = week(1);
    expect(await run(now, integrations)).toMatchObject({ outcome: "reported" });
    const report = (await reportOf(auditWeekOn(now)))!;
    const json = JSON.stringify(report.findings);
    for (const pii of ["Marie", "Dubois", "marie.dubois", "@example.com", "470", "Griet", "Verhaegen", "Lid sinds"]) expect(json).not.toContain(pii);
    const mine = report.findings.filter((x) => x.pageId === f.pageId);
    expect(mine.find((x) => x.code === "content_thin")!.message).toContain("[name]");
    expect(mine.find((x) => x.code === "content_thin")!.message).toContain("[email]");
    expect(mine.find((x) => x.code === "content_thin")!.message).toContain("[phone]");
    // fr-BE is not a locale of the page: Claude's finding for it is dropped (the missing locale is reported by the check).
    expect(mine.filter((x) => x.locale === "fr-BE").map((x) => x.code)).toEqual([AUDIT_LOCALE_MISSING]);
    expect(mine.find((x) => x.locale === "en" && x.severity === "info")!.code).toBe("other");
    const known = new Set((await h.db.select({ id: pages.id }).from(pages)).map((p) => p.id));
    for (const x of report.findings) {
      expect(known.has(x.pageId)).toBe(true);
      expect(x.message.length).toBeLessThanOrEqual(300);
    }
    for (const x of report.findings.filter((y) => y.pageId === f.pageId && (AUDIT_AI_CODES as readonly string[]).includes(y.code))) expect(["nl-BE", "en"]).toContain(x.locale);
    // Nothing personal was sent either.
    const prompt = auditCalls(integrations).map((c) => c.input.system + c.input.messages.map((m) => m.content).join("\n")).join("\n");
    for (const pii of ["Marie Dubois", "marie.dubois@example.com", "470 12 34 56", "Griet", "Lid sinds"]) expect(prompt).not.toContain(pii);
    expect(prompt).toContain("Heerlijke sauna.");
  });

  it("reports broken references and missing locales without Claude's help", async () => {
    const product = await makeProduct(h.db, { isActive: false });
    const f = await pageWithRequest(h.db, { locales: ["nl-BE"] });
    const [live] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, f.liveId));
    const pricing: Block = { id: randomUUID(), type: "pricing_table", productIds: [product.id], showMemberPrice: false };
    await h.db.update(pageVersions).set({ blocks: { "nl-BE": [...live!.blocks["nl-BE"]!, pricing] } }).where(eq(pageVersions.id, f.liveId));
    const now = week(2);
    expect(await run(now, scripted([]))).toMatchObject({ outcome: "reported" });
    const mine = (await reportOf(auditWeekOn(now)))!.findings.filter((x) => x.pageId === f.pageId);
    expect(mine).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "product_inactive", severity: "warn", locale: "nl-BE" }),
        expect.objectContaining({ code: AUDIT_LOCALE_MISSING, severity: "info", locale: "fr-BE" }),
        expect.objectContaining({ code: AUDIT_LOCALE_MISSING, severity: "info", locale: "en" }),
      ]),
    );
  });

  it("a retryable provider error retries; on the last attempt the page is skipped and the report is written", async () => {
    await pageWithRequest(h.db);
    const integrations = scripted([]);
    integrations.anthropic.failNext("overloaded");
    const now = week(3);
    await expect(run(now, integrations, 1)).rejects.toMatchObject({ retryable: true });
    expect(await reportOf(auditWeekOn(now))).toBeNull();
    integrations.anthropic.failNext("overloaded");
    expect(await run(now, integrations, 3)).toMatchObject({ outcome: "reported", skippedPages: 1 });
    expect(await reportOf(auditWeekOn(now))).not.toBeNull();
  });

  it("the latest report lists findings with page titles and drops archived pages", async () => {
    const f = await pageWithRequest(h.db, { locales: ["nl-BE"] });
    const g = await pageWithRequest(h.db, { locales: ["nl-BE"] });
    const now = week(40);
    expect(await run(now, scripted([]))).toMatchObject({ outcome: "reported" });
    await h.db.update(pages).set({ status: "archived" }).where(eq(pages.id, g.pageId));
    const view = (await getLatestAuditReport("en", h.db))!;
    expect(view.weekOn).toBe(auditWeekOn(now));
    const own = view.findings.filter((x) => x.pageId === f.pageId);
    expect(own.length).toBeGreaterThan(0);
    expect(own[0]!.title).toContain("Title prop-");
    expect(view.findings.some((x) => x.pageId === g.pageId)).toBe(false);
  });
});

describe("budget", () => {
  it("a budget refusal leaves no report and ends the run without throwing, every time", async () => {
    await pageWithRequest(h.db);
    const current = await getSetting(h.db, "ai");
    const versionOf = async () => Number(((await h.db.execute(sql`select coalesce(max(version), 0) as v from settings where key = 'ai'`)) as unknown as { rows: { v: number }[] }).rows[0]!.v);
    await setSetting(makeCtx(h.db), "ai", { ...current, monthly_budget_cents: 1 }, await versionOf());
    await h.db.insert(aiRequests).values({ feature: "ai.classify", model: "claude-haiku-5-5", actor: { kind: "system", id: null }, prompt: "x", status: "ok", costCents: "5" });
    try {
      const now = week(4);
      const integrations = scripted([]);
      for (let i = 0; i < 2; i++) {
        expect(await run(now, integrations)).toEqual({ outcome: "skipped", weekOn: auditWeekOn(now), reason: "budget_exceeded" });
        expect(await reportOf(auditWeekOn(now))).toBeNull();
      }
      expect(auditCalls(integrations)).toHaveLength(0);
    } finally {
      await setSetting(makeCtx(h.db), "ai", current, await versionOf());
    }
  });
});

describe("maskPersonalData", () => {
  it("masks emails, phone numbers and given names but keeps dates and short numbers", () => {
    expect(maskPersonalData("Mail jan@example.com or call 0470/12.34.56 or +32 2 123 45 67", ["Jan Peeters"])).toBe("Mail [email] or call [phone] or [phone]");
    expect(maskPersonalData("Thanks Jan Peeters, see you on 2026-11-02 at 9 or 12.", ["Jan Peeters"])).toBe("Thanks [name], see you on 2026-11-02 at 9 or 12.");
  });
});

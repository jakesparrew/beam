/**
 * site-P4 `site.propose_page` (site spec section 4 jobs, rules 42-44 and 56, edge cases 7-10, 38):
 * a valid answer becomes a `proposed` version by Claude; one repair round; a second invalid answer
 * ends `invalid_output` with no version; budget refusal, retries, the last attempt, an archived page,
 * a cancelled request, a dead job, and a double run that yields one version.
 * site-P10 (R4): translate requests keep the source locale and its block ids and structure and only
 * add the target locales.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { aiRequests, pageEditRequests, pages, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import type { Locale } from "@beam/core/i18n";
import { paragraphDoc, type Block, type VersionContent } from "@beam/core/site";
import type { ClaudeRequest } from "@beam/integrations/anthropic";

vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock("next/server", () => ({ after: () => undefined }));
const FORM_SLUG = "p4-contact";
vi.mock("@/modules/forms/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPublishedForms: () => Promise.resolve([{ id: "00000000-0000-4000-8000-0000000000f4", slug: FORM_SLUG, name: { en: "Contact" }, locales: ["nl-BE", "fr-BE", "en"] }]),
}));

const { and, eq, setAppDb, sql } = await import("@/lib/ctx");
const { createFakeIntegrations, makeCtx, makeJobCtx, resetRuntime, runJobTwice } = await import("@/lib/testing");
const { getSetting, setSetting } = await import("@/lib/settings");
const { mergeTranslation, onProposePageDead, proposePage, translationErrors } = await import("./propose");
const { droppedLocaleAnswer, pageWithRequest, unparsableAnswer, validAnswer } = await import("./site-p4.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** Fakes whose `site.propose_page` answers come from `answers` in order (the last one repeats). */
function scripted(answers: (Record<string, unknown> | string)[]) {
  const integrations = createFakeIntegrations();
  let n = 0;
  integrations.anthropic.script("site.propose_page", () => answers[Math.min(n++, answers.length - 1)]!);
  return integrations;
}

const requestRow = async (id: string) => (await h.db.select().from(pageEditRequests).where(eq(pageEditRequests.id, id)))[0]!;
const versionsOf = (pageId: string) => h.db.select().from(pageVersions).where(eq(pageVersions.pageId, pageId)).orderBy(pageVersions.version);
const run = (requestId: string, integrations: ReturnType<typeof createFakeIntegrations>, attempt = 1) =>
  proposePage(makeJobCtx(h.db, "site.propose_page", { integrations, attempt }), { editRequestId: requestId });
const promptOf = (c: { input: ClaudeRequest }) => c.input.system + c.input.messages.map((m) => m.content).join("\n");

describe("site.propose_page", () => {
  it("writes a proposed version by Claude for the requester; the second run changes nothing", async () => {
    const f = await pageWithRequest(h.db);
    const integrations = scripted([validAnswer(f.base)]);
    const { first, second } = await runJobTwice(h.db, "site.propose_page", { editRequestId: f.requestId }, { integrations });
    expect(first).toMatchObject({ outcome: "proposed", repaired: false });
    expect(second).toMatchObject({ outcome: "skipped" });
    const versions = await versionsOf(f.pageId);
    expect(versions).toHaveLength(2);
    const proposal = versions[1]!;
    expect(proposal).toMatchObject({ state: "proposed", createdBy: "claude", createdByUserId: f.requesterId, editRequestId: f.requestId, basedOnVersionId: f.liveId, version: 2, publishedAt: null });
    expect(proposal.blocks.en!.at(-1)).toMatchObject({ type: "faq" });
    expect(proposal.blocks.en![0]!.id).toBe(f.base.blocks.en![0]!.id);
    expect(proposal.changeSummary).toBe("Added an FAQ about opening hours.");
    const req = await requestRow(f.requestId);
    expect(req).toMatchObject({ status: "succeeded", resultVersionId: proposal.id, errorCode: null });
    expect(req.aiRequestId).toBe(proposal.proposedByAiRequestId);
    const [ai] = await h.db.select().from(aiRequests).where(eq(aiRequests.id, req.aiRequestId!));
    expect(ai).toMatchObject({ feature: "site.propose_page", model: "claude-opus-5-5", status: "ok" });
    expect(integrations.anthropic.calls).toHaveLength(1);
    expect(integrations.anthropic.calls[0]!.input).toMatchObject({ model: "claude-opus-5-5", maxTokens: 16000 });
    expect(integrations.anthropic.calls[0]!.input.outputSchema).toBeTruthy();
    expect((await h.db.select().from(pages).where(eq(pages.id, f.pageId)))[0]!.currentVersionId).toBe(f.liveId);
  });

  it("repairs an unparsable answer once", async () => {
    const f = await pageWithRequest(h.db);
    const integrations = scripted([unparsableAnswer(), validAnswer(f.base)]);
    expect(await run(f.requestId, integrations)).toMatchObject({ outcome: "proposed", repaired: true });
    expect(integrations.anthropic.calls).toHaveLength(2);
    const repair = integrations.anthropic.calls[1]!.input.messages;
    expect(repair.at(-1)).toMatchObject({ role: "user", content: expect.stringContaining("not a valid page proposal") });
    expect(await versionsOf(f.pageId)).toHaveLength(2);
  });

  it("repairs a proposal that drops a locale, sending back the previous answer and the errors", async () => {
    const f = await pageWithRequest(h.db);
    const integrations = scripted([droppedLocaleAnswer(f.base), validAnswer(f.base)]);
    expect(await run(f.requestId, integrations)).toMatchObject({ outcome: "proposed", repaired: true });
    const repair = integrations.anthropic.calls[1]!.input.messages;
    expect(repair.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(repair[2]!.content).toContain("removes en");
  });

  it("invalid twice ends the request invalid_output with no version", async () => {
    const f = await pageWithRequest(h.db);
    const integrations = scripted([unparsableAnswer(), droppedLocaleAnswer(f.base)]);
    expect(await run(f.requestId, integrations)).toEqual({ outcome: "failed", errorCode: "invalid_output" });
    expect(integrations.anthropic.calls).toHaveLength(2);
    expect(await versionsOf(f.pageId)).toHaveLength(1);
    expect(await requestRow(f.requestId)).toMatchObject({ status: "failed", errorCode: "invalid_output", resultVersionId: null, finishedAt: expect.any(Date) });
  });

  it("rejects a kind change and a dropped locale (rule 44)", async () => {
    const f = await pageWithRequest(h.db);
    const kindChange = { ...validAnswer(f.base), kind: "landing" };
    expect(await run(f.requestId, scripted([kindChange]))).toEqual({ outcome: "failed", errorCode: "invalid_output" });
    const g = await pageWithRequest(h.db);
    expect(await run(g.requestId, scripted([droppedLocaleAnswer(g.base)]))).toEqual({ outcome: "failed", errorCode: "invalid_output" });
    expect(await versionsOf(f.pageId)).toHaveLength(1);
    expect(await versionsOf(g.pageId)).toHaveLength(1);
  });

  it("retries a provider error, then succeeds", async () => {
    const f = await pageWithRequest(h.db);
    const integrations = scripted([validAnswer(f.base)]);
    integrations.anthropic.failNext("overloaded");
    await expect(run(f.requestId, integrations, 1)).rejects.toMatchObject({ retryable: true });
    expect(await requestRow(f.requestId)).toMatchObject({ status: "pending", errorCode: null });
    expect(await run(f.requestId, integrations, 2)).toMatchObject({ outcome: "proposed" });
  });

  it("the last attempt failing ends the request ai_unavailable", async () => {
    const f = await pageWithRequest(h.db);
    const integrations = scripted([validAnswer(f.base)]);
    integrations.anthropic.failNext("rate_limited");
    expect(await run(f.requestId, integrations, 3)).toEqual({ outcome: "failed", errorCode: "ai_unavailable" });
    expect(await requestRow(f.requestId)).toMatchObject({ status: "failed", errorCode: "ai_unavailable" });
    expect(await versionsOf(f.pageId)).toHaveLength(1);
  });

  it("an archived page fails the request page_archived without calling Claude", async () => {
    const f = await pageWithRequest(h.db, { status: "archived" });
    const integrations = scripted([validAnswer(f.base)]);
    expect(await run(f.requestId, integrations)).toEqual({ outcome: "failed", errorCode: "page_archived" });
    expect(integrations.anthropic.calls).toHaveLength(0);
    expect(await versionsOf(f.pageId)).toHaveLength(1);
    expect(await requestRow(f.requestId)).toMatchObject({ status: "failed", errorCode: "page_archived" });
  });

  it("does nothing for a cancelled or unknown request", async () => {
    const f = await pageWithRequest(h.db);
    await h.db.update(pageEditRequests).set({ status: "cancelled" }).where(eq(pageEditRequests.id, f.requestId));
    const integrations = scripted([validAnswer(f.base)]);
    expect(await run(f.requestId, integrations)).toEqual({ outcome: "skipped", reason: "request_cancelled" });
    expect(await run(randomUUID(), integrations)).toEqual({ outcome: "skipped", reason: "request_missing" });
    expect(integrations.anthropic.calls).toHaveLength(0);
  });

  it("a dead job leaves the request failed ai_unavailable", async () => {
    const f = await pageWithRequest(h.db);
    await onProposePageDead(makeJobCtx(h.db, "site.propose_page"), { editRequestId: f.requestId }, { message: "stale lock", permanent: false });
    expect(await requestRow(f.requestId)).toMatchObject({ status: "failed", errorCode: "ai_unavailable" });
  });

  it("only references the form, product, session and page lists it was given", async () => {
    const f = await pageWithRequest(h.db);
    const answer = validAnswer(f.base);
    const unknown = { ...answer, blocks: { ...(answer.blocks as object), en: [...((answer.blocks as Record<string, unknown[]>).en ?? []), { id: randomUUID(), type: "form_embed", formSlug: "not-a-form" }] } };
    const known = { ...answer, blocks: { ...(answer.blocks as object), en: [...((answer.blocks as Record<string, unknown[]>).en ?? []), { id: randomUUID(), type: "form_embed", formSlug: FORM_SLUG }] } };
    const integrations = scripted([unknown, known]);
    expect(await run(f.requestId, integrations)).toMatchObject({ outcome: "proposed", repaired: true });
    expect(integrations.anthropic.calls[1]!.input.messages.at(-1)!.content).toContain("unknown form not-a-form");
    expect(promptOf(integrations.anthropic.calls[0]!)).toContain(FORM_SLUG);
  });
});

describe("budget", () => {
  it("a budget refusal ends the request budget_exceeded at once", async () => {
    const current = await getSetting(h.db, "ai");
    const versionOf = async () => Number(((await h.db.execute(sql`select coalesce(max(version), 0) as v from settings where key = 'ai'`)) as unknown as { rows: { v: number }[] }).rows[0]!.v);
    await setSetting(makeCtx(h.db), "ai", { ...current, monthly_budget_cents: 1 }, await versionOf());
    await h.db.insert(aiRequests).values({ feature: "ai.classify", model: "claude-haiku-5-5", actor: { kind: "system", id: null }, prompt: "x", status: "ok", costCents: "5" });
    try {
      const f = await pageWithRequest(h.db);
      const integrations = scripted([validAnswer(f.base)]);
      expect(await run(f.requestId, integrations)).toEqual({ outcome: "failed", errorCode: "budget_exceeded" });
      expect(integrations.anthropic.calls).toHaveLength(0);
      expect(await requestRow(f.requestId)).toMatchObject({ status: "failed", errorCode: "budget_exceeded" });
      expect(await versionsOf(f.pageId)).toHaveLength(1);
      const logged = await h.db.select().from(aiRequests).where(and(eq(aiRequests.feature, "site.propose_page"), eq(aiRequests.status, "budget_exceeded")));
      expect(logged.length).toBeGreaterThan(0);
    } finally {
      await setSetting(makeCtx(h.db), "ai", current, await versionOf());
    }
  });
});

// ---------------------------------------------------------------------------------------------
// site-P10 (R4): "Translate missing locales" (`kind: 'translate'`)
// ---------------------------------------------------------------------------------------------

/** A page live in nl-BE only (text, CTA, booking button) with a pending translate request for fr-BE and en. */
async function translateFixture() {
  const f = await pageWithRequest(h.db, { locales: ["nl-BE"] });
  const nl = f.base.blocks["nl-BE"]!;
  const blocks: Block[] = [
    ...nl,
    { id: randomUUID(), type: "cta", heading: "Kom langs", text: "Wij verwelkomen je graag.", button: { label: "Boek nu", link: { kind: "url", href: "https://www.example.com/boeken" } } },
    { id: randomUUID(), type: "booking_cta", label: "Boek een dag", target: { kind: "book_day" } },
  ];
  await h.db.update(pageVersions).set({ blocks: { "nl-BE": blocks } }).where(eq(pageVersions.id, f.liveId));
  await h.db.update(pageEditRequests).set({ kind: "translate", locales: ["fr-BE", "en"], instruction: "Translate the page into fr-BE, en." }).where(eq(pageEditRequests.id, f.requestId));
  return { ...f, base: { ...f.base, blocks: { "nl-BE": blocks } } };
}

const TARGETS = ["fr-BE", "en"] as const;

/** A translation of the nl-BE blocks: same ids, types and references, translated text. */
function translatedBlocks(src: Block[], l: Locale): Block[] {
  return src.map((b): Block => {
    if (b.type === "rich_text") return { ...b, doc: paragraphDoc(`Welcome (${l}).`) };
    if (b.type === "cta") return { ...b, heading: `Visit us (${l})`, text: `We welcome you (${l}).`, button: { ...b.button, label: `Book now (${l})` } };
    if (b.type === "booking_cta") return { ...b, label: `Book a day (${l})` };
    return b;
  });
}

/** Claude's translation answer: only the target locales (unless `withSource` adds a changed nl-BE). */
function translationAnswer(base: VersionContent, opts: { withSource?: boolean; blocks?: (l: Locale, src: Block[]) => Block[] } = {}): Record<string, Record<string, unknown> | string> {
  const src = base.blocks["nl-BE"]!;
  const pick = <T>(fn: (l: Locale) => T): Record<string, T> => Object.fromEntries(TARGETS.map((l) => [l, fn(l)]));
  const blocksOf = opts.blocks ?? ((l: Locale, s: Block[]) => translatedBlocks(s, l));
  const answer = {
    title: pick((l) => `Title (${l})`),
    paths: pick((l) => `translated-${l.slice(0, 2)}`),
    blocks: pick((l) => blocksOf(l, src)),
    seo: pick((l) => ({ title: `BEAM (${l})`, description: `A translated description that is long enough for search engines in ${l}.` })),
    changeSummary: "Added fr-BE and en.",
  };
  if (!opts.withSource) return answer;
  return {
    ...answer,
    title: { ...answer.title, "nl-BE": "Changed Dutch title" },
    blocks: { ...answer.blocks, "nl-BE": [{ id: randomUUID(), type: "rich_text", doc: paragraphDoc("Nieuwe tekst.") }] },
  };
}

describe("site.propose_page translate (site-P10)", () => {
  it("adds only the target locales, keeping the source locale and its block ids and structure", async () => {
    const f = await translateFixture();
    const integrations = scripted([translationAnswer(f.base)]);
    const { first, second } = await runJobTwice(h.db, "site.propose_page", { editRequestId: f.requestId }, { integrations });
    expect(first).toMatchObject({ outcome: "proposed", repaired: false });
    expect(second).toMatchObject({ outcome: "skipped" });
    const versions = await versionsOf(f.pageId);
    expect(versions).toHaveLength(2);
    const live = versions[0]!;
    const proposal = versions[1]!;
    expect(proposal).toMatchObject({ state: "proposed", createdBy: "claude", editRequestId: f.requestId, basedOnVersionId: f.liveId });
    expect(proposal.locales).toEqual(["nl-BE", "fr-BE", "en"]);
    // The source locale is untouched.
    expect(proposal.blocks["nl-BE"]).toEqual(live.blocks["nl-BE"]);
    expect(proposal.title["nl-BE"]).toBe(live.title["nl-BE"]);
    expect(proposal.paths["nl-BE"]).toBe(live.paths["nl-BE"]);
    expect(proposal.seo["nl-BE"]).toEqual(live.seo["nl-BE"]);
    // Every target repeats the source blocks' ids, order and types.
    const shape = (bs: Block[] | undefined) => (bs ?? []).map((b) => [b.id, b.type]);
    for (const l of TARGETS) {
      expect(shape(proposal.blocks[l])).toEqual(shape(live.blocks["nl-BE"]));
      expect(proposal.title[l]).toBe(`Title (${l})`);
    }
    const prompt = promptOf(integrations.anthropic.calls[0]!);
    expect(prompt).toContain('"task":"translate_page"');
    expect(prompt).toContain('"sourceLocale":"nl-BE"');
    expect(prompt).toContain("Return only the target locales (fr-BE, en)");
    expect(await requestRow(f.requestId)).toMatchObject({ status: "succeeded", resultVersionId: proposal.id });
  });

  it("ignores a changed source locale in the answer: the base locales stay exactly as they were", async () => {
    const f = await translateFixture();
    expect(await run(f.requestId, scripted([translationAnswer(f.base, { withSource: true })]))).toMatchObject({ outcome: "proposed" });
    const [live, proposal] = await versionsOf(f.pageId);
    expect(proposal!.blocks["nl-BE"]).toEqual(live!.blocks["nl-BE"]);
    expect(proposal!.title["nl-BE"]).toBe(live!.title["nl-BE"]);
  });

  it("repairs a translation that adds a block, and fails after a changed reference and a reordering", async () => {
    const f = await translateFixture();
    const extra = translationAnswer(f.base, { blocks: (l, src) => [...translatedBlocks(src, l), { id: randomUUID(), type: "rich_text", doc: paragraphDoc("Extra.") }] });
    const integrations = scripted([extra, translationAnswer(f.base)]);
    expect(await run(f.requestId, integrations)).toMatchObject({ outcome: "proposed", repaired: true });
    expect(integrations.anthropic.calls[1]!.input.messages.at(-1)!.content).toContain("translate every block and add none");

    const g = await translateFixture();
    const changedTarget = translationAnswer(g.base, { blocks: (l, src) => translatedBlocks(src, l).map((b): Block => (b.type === "booking_cta" ? { ...b, target: { kind: "gift" } } : b)) });
    const reordered = translationAnswer(g.base, { blocks: (l, src) => [...translatedBlocks(src, l)].reverse() });
    const bad = scripted([changedTarget, reordered]);
    expect(await run(g.requestId, bad)).toEqual({ outcome: "failed", errorCode: "invalid_output" });
    expect(bad.anthropic.calls[1]!.input.messages.at(-1)!.content).toContain("changes references");
    expect(await versionsOf(g.pageId)).toHaveLength(1);
    expect(await requestRow(g.requestId)).toMatchObject({ status: "failed", errorCode: "invalid_output" });
  });

  it("requires every target locale; a request with nothing left to translate fails without calling Claude", async () => {
    const f = await translateFixture();
    const onlyFr = translationAnswer(f.base);
    delete (onlyFr.title as Record<string, unknown>).en;
    delete (onlyFr.blocks as Record<string, unknown>).en;
    const integrations = scripted([onlyFr, onlyFr]);
    expect(await run(f.requestId, integrations)).toEqual({ outcome: "failed", errorCode: "invalid_output" });
    expect(integrations.anthropic.calls[1]!.input.messages.at(-1)!.content).toContain("title.en");

    const g = await pageWithRequest(h.db);
    await h.db.update(pageEditRequests).set({ kind: "translate", locales: ["en"] }).where(eq(pageEditRequests.id, g.requestId));
    const none = scripted([validAnswer(g.base)]);
    expect(await run(g.requestId, none)).toEqual({ outcome: "failed", errorCode: "invalid_output" });
    expect(none.anthropic.calls).toHaveLength(0);
    expect(await requestRow(g.requestId)).toMatchObject({ status: "failed", errorMessage: "nothing_to_translate" });
  });
});

describe("translation helpers (site-P10)", () => {
  const src: Block[] = [
    { id: "11111111-1111-4111-8111-111111111111", type: "rich_text", doc: paragraphDoc("Hallo.") },
    { id: "22222222-2222-4222-8222-222222222222", type: "pricing_table", heading: "Prijzen", productIds: ["33333333-3333-4333-8333-333333333333"], showMemberPrice: true },
  ];
  const base: VersionContent = { title: { "nl-BE": "Prijzen" }, paths: { "nl-BE": "prijzen" }, blocks: { "nl-BE": src }, seo: {}, excerpt: null, coverMediaId: null, locales: ["nl-BE"] };

  it("mergeTranslation keeps the base locales and takes only the targets from the answer", () => {
    const merged = mergeTranslation(base, { title: { "nl-BE": "X", en: "Prices", "fr-BE": "Prix" }, blocks: { "nl-BE": [], en: src }, paths: {}, seo: {}, changeSummary: "x" }, ["en"]) as Record<string, Record<string, unknown>>;
    expect(merged.title).toEqual({ "nl-BE": "Prijzen", en: "Prices" });
    expect(merged.blocks).toEqual({ "nl-BE": src, en: src });
    expect(merged.paths).toEqual({ "nl-BE": "prijzen" });
    expect(mergeTranslation(base, "not json", ["en"])).toBe("not json");
  });

  it("translationErrors allows different text but not different references, switches or order", () => {
    const en = src.map((b): Block => (b.type === "pricing_table" ? { ...b, heading: "Prices" } : b.type === "rich_text" ? { ...b, doc: paragraphDoc("Hello.") } : b));
    expect(translationErrors({ title: { "nl-BE": "Prijzen", en: "Prices" }, blocks: { "nl-BE": src, en } }, "nl-BE", ["en"])).toEqual([]);
    const switched = en.map((b): Block => (b.type === "pricing_table" ? { ...b, showMemberPrice: false } : b));
    expect(translationErrors({ title: { en: "Prices" }, blocks: { "nl-BE": src, en: switched } }, "nl-BE", ["en"])).toHaveLength(1);
    expect(translationErrors({ title: { en: "Prices" }, blocks: { "nl-BE": src, en: [...en].reverse() } }, "nl-BE", ["en"])).toHaveLength(2);
    expect(translationErrors({ title: {}, blocks: { "nl-BE": src } }, "nl-BE", ["en"])).toHaveLength(2);
  });
});

describe("site.propose_page with the fake's default answer (e2e, INTEGRATIONS=fake)", () => {
  it("an edit keeps the base blocks and appends an FAQ block per locale", async () => {
    const f = await pageWithRequest(h.db);
    expect(await run(f.requestId, createFakeIntegrations())).toMatchObject({ outcome: "proposed", repaired: false });
    const [live, proposal] = await versionsOf(f.pageId);
    for (const l of f.base.locales) {
      expect(proposal!.blocks[l]!.slice(0, -1)).toEqual(live!.blocks[l]);
      expect(proposal!.blocks[l]!.at(-1)).toMatchObject({ type: "faq", items: [{ question: expect.any(String) }] });
    }
    expect(proposal!.title).toEqual(live!.title);
  });

  it("a translation fills the target locales with the source blocks' structure", async () => {
    const f = await translateFixture();
    expect(await run(f.requestId, createFakeIntegrations())).toMatchObject({ outcome: "proposed", repaired: false });
    const [live, proposal] = await versionsOf(f.pageId);
    expect(proposal!.locales).toEqual(["nl-BE", "fr-BE", "en"]);
    expect(proposal!.blocks["nl-BE"]).toEqual(live!.blocks["nl-BE"]);
    for (const l of TARGETS) expect(proposal!.blocks[l]!.map((b) => b.id)).toEqual(live!.blocks["nl-BE"]!.map((b) => b.id));
  });
});

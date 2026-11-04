/**
 * site-P4 `site.propose_page` (site spec section 4 jobs, rules 42-44 and 56, edge cases 7-10, 38):
 * a valid answer becomes a `proposed` version by Claude; one repair round; a second invalid answer
 * ends `invalid_output` with no version; budget refusal, retries, the last attempt, an archived page,
 * a cancelled request, a dead job, and a double run that yields one version.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { aiRequests, pageEditRequests, pages, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
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
const { onProposePageDead, proposePage } = await import("./propose");
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

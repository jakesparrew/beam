/**
 * site-P4 proposal actions (site spec section 4, rules 41, 46, 55-56): asking Claude needs `ai.use`;
 * one active request per page; only a pending request can be cancelled; rejecting records the
 * reason; "Edit as draft" respects `replaceExisting` and supersedes the proposal; publishing a
 * proposal needs `site.publish`; the Claude panel's state is hidden without `ai.use`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, pageEditRequests, pages, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import type { Locale } from "@beam/core/i18n";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.44" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const proposals = await import("./proposals");
const pagesActions = await import("./pages");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { publishable, queued, slug, staffSession } = await import("../site-p3.fixtures");
const { faqBlock } = await import("../jobs/site-p4.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => jar.clear());

const EDITOR = ["site.edit", "site.publish", "ai.use"];

function ok<T>(r: { ok: boolean; data?: T; error?: unknown }): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data as T;
}

/** A page with a draft holding publishable content, as the editor creates it. */
async function draftPage(locales: Locale[] = ["nl-BE", "fr-BE", "en"]) {
  const s = slug("cp");
  const created = ok(await pagesActions.createPage({ kind: "standard", slug: s, title: { "nl-BE": s }, locales }));
  const content = publishable(s, locales);
  const [row] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, created.versionId));
  const saved = ok(await pagesActions.saveDraft({ pageId: created.pageId, versionId: created.versionId, expectedUpdatedAt: row!.updatedAt.toISOString(), ...content }));
  return { pageId: created.pageId, draftId: saved.versionId, content };
}

/** A Claude proposal row based on `basedOn` (as `site.propose_page` writes it). */
async function proposal(pageId: string, basedOn: string, content: ReturnType<typeof publishable>, userId: string) {
  const max = Math.max(...(await h.db.select({ v: pageVersions.version }).from(pageVersions).where(eq(pageVersions.pageId, pageId))).map((r) => r.v));
  const blocks = Object.fromEntries(content.locales.map((l) => [l, [...(content.blocks[l] ?? []), faqBlock(l)]]));
  const [req] = await h.db.insert(pageEditRequests).values({ pageId, instruction: "Add an FAQ", locales: content.locales, baseVersionId: basedOn, requestedByUserId: userId, status: "succeeded" }).returning();
  const [v] = await h.db
    .insert(pageVersions)
    .values({ pageId, version: max + 1, state: "proposed", ...content, blocks, changeSummary: "Added an FAQ", basedOnVersionId: basedOn, createdBy: "claude", createdByUserId: userId, editRequestId: req!.id })
    .returning();
  await h.db.update(pageEditRequests).set({ resultVersionId: v!.id }).where(eq(pageEditRequests.id, req!.id));
  return v!;
}

const versionRow = async (id: string) => (await h.db.select().from(pageVersions).where(eq(pageVersions.id, id)))[0]!;
const requestRow = async (id: string) => (await h.db.select().from(pageEditRequests).where(eq(pageEditRequests.id, id)))[0]!;

describe("requestProposal and cancelProposalRequest", () => {
  it("requires ai.use besides site.edit", async () => {
    await staffSession(h.db, jar, ["site.edit"]);
    const d = await draftPage();
    expect(await proposals.requestProposal({ pageId: d.pageId, instruction: "Add an FAQ", kind: "edit" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await proposals.getClaudePanelState({ pageId: d.pageId })).toEqual({ ok: true, data: { allowed: false } });
    expect(await h.db.select().from(pageEditRequests).where(eq(pageEditRequests.pageId, d.pageId))).toHaveLength(0);
  });

  it("creates a pending request on the draft, enqueues the job and audits it", async () => {
    const user = await staffSession(h.db, jar, EDITOR);
    const d = await draftPage(["nl-BE", "en"]);
    const { editRequestId } = ok(await proposals.requestProposal({ pageId: d.pageId, instruction: "  Add an FAQ about parking  ", kind: "edit" }));
    const req = await requestRow(editRequestId);
    expect(req).toMatchObject({ status: "pending", kind: "edit", instruction: "Add an FAQ about parking", locales: ["nl-BE", "en"], baseVersionId: d.draftId, requestedByUserId: user.id });
    expect(req.baseUpdatedAt).toBeInstanceOf(Date);
    const jobs = (await queued(h.db, "site.propose_page")).filter((j) => (j.payload as { editRequestId: string }).editRequestId === editRequestId);
    expect(jobs).toEqual([expect.objectContaining({ idempotencyKey: `page_edit:${editRequestId}:propose` })]);
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.proposal.request"), eq(auditLog.entityId, d.pageId)));
    expect(audit!.newValue).toMatchObject({ editRequestId, kind: "edit" });
    const state = ok(await proposals.getClaudePanelState({ pageId: d.pageId }));
    expect(state).toMatchObject({ allowed: true, request: { editRequestId, status: "pending" } });
  });

  it("allows one active request per page", async () => {
    await staffSession(h.db, jar, EDITOR);
    const d = await draftPage();
    const first = ok(await proposals.requestProposal({ pageId: d.pageId, instruction: "First change", locales: ["en"], kind: "edit" }));
    expect(await proposals.requestProposal({ pageId: d.pageId, instruction: "Second change", kind: "edit" })).toMatchObject({ ok: false, error: { code: "conflict", message: "request_active" } });
    ok(await proposals.cancelProposalRequest({ editRequestId: first.editRequestId }));
    expect(await requestRow(first.editRequestId)).toMatchObject({ status: "cancelled", finishedAt: expect.any(Date) });
    ok(await proposals.requestProposal({ pageId: d.pageId, instruction: "Second change", kind: "new_page" }));
  });

  it("cancels only a pending request", async () => {
    await staffSession(h.db, jar, EDITOR);
    const d = await draftPage();
    const { editRequestId } = ok(await proposals.requestProposal({ pageId: d.pageId, instruction: "Change it", kind: "edit" }));
    await h.db.update(pageEditRequests).set({ status: "running" }).where(eq(pageEditRequests.id, editRequestId));
    expect(await proposals.cancelProposalRequest({ editRequestId })).toMatchObject({ ok: false, error: { code: "conflict", message: "request_running" } });
    await h.db.update(pageEditRequests).set({ status: "succeeded" }).where(eq(pageEditRequests.id, editRequestId));
    expect(await proposals.cancelProposalRequest({ editRequestId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await proposals.cancelProposalRequest({ editRequestId: randomUUID() })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("refuses a request for an archived page and an instruction under 3 characters", async () => {
    await staffSession(h.db, jar, EDITOR);
    const d = await draftPage();
    expect(await proposals.requestProposal({ pageId: d.pageId, instruction: "ab", kind: "edit" })).toMatchObject({ ok: false, error: { code: "validation" } });
    ok(await pagesActions.archivePage({ pageId: d.pageId }));
    expect(await proposals.requestProposal({ pageId: d.pageId, instruction: "Change it", kind: "edit" })).toMatchObject({ ok: false, error: { code: "conflict", message: "page_archived" } });
  });
});

describe("reviewing a proposal", () => {
  it("reject sets the reason and is final", async () => {
    const user = await staffSession(h.db, jar, ["site.edit"]);
    const d = await draftPage();
    const p = await proposal(d.pageId, d.draftId, d.content, user.id);
    expect(await proposals.rejectProposal({ versionId: p.id, reason: "" })).toMatchObject({ ok: false, error: { code: "validation" } });
    ok(await proposals.rejectProposal({ versionId: p.id, reason: "Too long" }));
    expect(await versionRow(p.id)).toMatchObject({ state: "rejected", rejectReason: "Too long", rejectedByUserId: user.id, rejectedAt: expect.any(Date) });
    expect(await proposals.rejectProposal({ versionId: p.id, reason: "Again" })).toMatchObject({ ok: false, error: { code: "conflict", message: "version_rejected" } });
    expect(await proposals.copyProposalToDraft({ versionId: p.id, replaceExisting: true })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("copy to draft respects replaceExisting and supersedes the proposal", async () => {
    const user = await staffSession(h.db, jar, ["site.edit"]);
    const d = await draftPage();
    const p = await proposal(d.pageId, d.draftId, d.content, user.id);
    expect(await proposals.copyProposalToDraft({ versionId: p.id, replaceExisting: false })).toMatchObject({ ok: false, error: { code: "conflict", message: "draft_exists" } });
    expect((await versionRow(p.id)).state).toBe("proposed");
    const { versionId } = ok(await proposals.copyProposalToDraft({ versionId: p.id, replaceExisting: true }));
    expect(versionId).toBe(d.draftId);
    const draft = await versionRow(versionId);
    expect(draft).toMatchObject({ state: "draft", createdBy: "user" });
    expect(draft.blocks.en!.at(-1)).toMatchObject({ type: "faq" });
    expect(await versionRow(p.id)).toMatchObject({ state: "superseded", publishedAt: null });
    const drafts = await h.db.select().from(pageVersions).where(and(eq(pageVersions.pageId, d.pageId), eq(pageVersions.state, "draft")));
    expect(drafts).toHaveLength(1);
    const [audit] = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.proposal.copy_to_draft"), eq(auditLog.entityId, d.pageId)));
    expect(audit!.newValue).toMatchObject({ proposalVersionId: p.id, draftVersionId: versionId });
  });

  it("copy to draft creates a draft when the page has none", async () => {
    const user = await staffSession(h.db, jar, EDITOR);
    const d = await draftPage();
    ok(await pagesActions.publishVersion({ versionId: d.draftId }));
    const p = await proposal(d.pageId, d.draftId, d.content, user.id);
    const { versionId } = ok(await proposals.copyProposalToDraft({ versionId: p.id, replaceExisting: false }));
    expect(versionId).not.toBe(d.draftId);
    expect(await versionRow(versionId)).toMatchObject({ state: "draft", basedOnVersionId: d.draftId, createdByUserId: user.id });
    expect((await versionRow(p.id)).state).toBe("superseded");
  });

  it("publishing a proposal requires site.publish", async () => {
    const user = await staffSession(h.db, jar, ["site.edit", "ai.use"]);
    const d = await draftPage();
    const p = await proposal(d.pageId, d.draftId, d.content, user.id);
    expect(await pagesActions.publishVersion({ versionId: p.id })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    jar.clear();
    await staffSession(h.db, jar, EDITOR);
    ok(await pagesActions.publishVersion({ versionId: p.id }));
    expect(await versionRow(p.id)).toMatchObject({ state: "published", createdBy: "claude" });
    expect((await h.db.select().from(pages).where(eq(pages.id, d.pageId)))[0]).toMatchObject({ status: "published", currentVersionId: p.id });
    expect((await versionRow(d.draftId)).state).toBe("draft");
  });
});

/**
 * site-P10 "Translate missing locales" (`requestProposal` with `kind: 'translate'`, R4): the request
 * targets exactly the locales the base lacks (narrowed by `locales` when given), needs no
 * instruction, and is refused when there is nothing to translate; `ai.use` and
 * the one-active-request lock apply as for every request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { pageEditRequests, pageVersions } from "@beam/db/schema";
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
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.45" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));

const proposals = await import("./proposals");
const pagesActions = await import("./pages");
const { eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { publishable, queued, slug, staffSession } = await import("../site-p3.fixtures");

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

/** A page whose draft holds publishable content in `locales`. */
async function draftPage(locales: Locale[]) {
  const s = slug("tr");
  const created = ok(await pagesActions.createPage({ kind: "standard", slug: s, title: { "nl-BE": s }, locales }));
  const [row] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, created.versionId));
  const saved = ok(await pagesActions.saveDraft({ pageId: created.pageId, versionId: created.versionId, expectedUpdatedAt: row!.updatedAt.toISOString(), ...publishable(s, locales) }));
  return { pageId: created.pageId, draftId: saved.versionId };
}

const requestRow = async (id: string) => (await h.db.select().from(pageEditRequests).where(eq(pageEditRequests.id, id)))[0]!;

describe("requestProposal kind translate", () => {
  it("targets the missing locales without an instruction and enqueues the proposal job", async () => {
    const user = await staffSession(h.db, jar, EDITOR);
    const d = await draftPage(["nl-BE"]);
    const { editRequestId } = ok(await proposals.requestProposal({ pageId: d.pageId, kind: "translate" }));
    const req = await requestRow(editRequestId);
    expect(req).toMatchObject({ status: "pending", kind: "translate", locales: ["fr-BE", "en"], baseVersionId: d.draftId, requestedByUserId: user.id });
    expect(req.instruction).toContain("fr-BE, en");
    const jobs = (await queued(h.db, "site.propose_page")).filter((j) => (j.payload as { editRequestId: string }).editRequestId === editRequestId);
    expect(jobs).toHaveLength(1);
    // One active request per page, translate or not.
    expect(await proposals.requestProposal({ pageId: d.pageId, kind: "translate" })).toMatchObject({ ok: false, error: { code: "conflict", message: "request_active" } });
  });

  it("narrows to the requested locales, never to one the page already has", async () => {
    await staffSession(h.db, jar, EDITOR);
    const d = await draftPage(["nl-BE"]);
    const { editRequestId } = ok(await proposals.requestProposal({ pageId: d.pageId, kind: "translate", locales: ["en", "nl-BE"] }));
    expect((await requestRow(editRequestId)).locales).toEqual(["en"]);
  });

  it("refuses a page in every locale and a user without ai.use", async () => {
    await staffSession(h.db, jar, EDITOR);
    const full = await draftPage(["nl-BE", "fr-BE", "en"]);
    expect(await proposals.requestProposal({ pageId: full.pageId, kind: "translate" })).toMatchObject({ ok: false, error: { code: "conflict", message: "translate_nothing_missing" } });
    const partial = await draftPage(["nl-BE", "en"]);
    expect(await proposals.requestProposal({ pageId: partial.pageId, kind: "translate", locales: ["en"] })).toMatchObject({ ok: false, error: { code: "conflict", message: "translate_nothing_missing" } });
    expect(await h.db.select().from(pageEditRequests).where(eq(pageEditRequests.pageId, full.pageId))).toHaveLength(0);

    await staffSession(h.db, jar, ["site.edit"]);
    const d = await draftPage(["nl-BE"]);
    expect(await proposals.requestProposal({ pageId: d.pageId, kind: "translate" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("still requires an instruction for edit and new_page requests", async () => {
    await staffSession(h.db, jar, EDITOR);
    const d = await draftPage(["nl-BE"]);
    expect(await proposals.requestProposal({ pageId: d.pageId, kind: "edit" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await proposals.requestProposal({ pageId: d.pageId, kind: "new_page" })).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

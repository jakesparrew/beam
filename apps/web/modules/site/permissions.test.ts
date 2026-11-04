/**
 * site-P3 action permissions (site spec section 7): editing actions need `site.edit`; publishing,
 * scheduling, unpublishing, archiving, restoring, navigation and redirects need `site.publish`.
 * Staff without them get `forbidden` before anything is written; a customer is `unauthorized`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { pages } from "@beam/db/schema";
import { createTestDb, makeUser } from "@beam/db/testing";
import { permissions } from "./permissions";

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

const pagesActions = await import("./actions/pages");
const navActions = await import("./actions/nav");
const redirectActions = await import("./actions/redirects");
const mediaActions = await import("./actions/media");
const { createAuthSession, SESSION_COOKIE } = await import("@/lib/auth");
const { setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { PNG_1X1, staffSession } = await import("./site-p3.fixtures");

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

type Call = [label: string, run: () => Promise<unknown>];
const id = () => randomUUID();
const content = { title: {}, paths: {}, blocks: {}, seo: {}, locales: ["nl-BE"], isMaterialChange: false };

function mediaForm(): FormData {
  const fd = new FormData();
  fd.set("file", new File([PNG_1X1], "dot.png", { type: "image/png" }));
  return fd;
}

const editCalls: Call[] = [
  ["createPage", () => pagesActions.createPage({ kind: "standard", slug: `perm-${id().slice(0, 8)}`, title: {}, locales: ["nl-BE"] })],
  ["saveDraft", () => pagesActions.saveDraft({ pageId: id(), ...content })],
  ["createDraftFromVersion", () => pagesActions.createDraftFromVersion({ pageId: id(), fromVersionId: id(), replaceExisting: false })],
  ["discardDraft", () => pagesActions.discardDraft({ versionId: id() })],
  ["uploadMedia", () => mediaActions.uploadMedia(mediaForm())],
  ["updateMedia", () => mediaActions.updateMedia({ mediaId: id(), alt: {}, isDecorative: false })],
  ["deleteMedia", () => mediaActions.deleteMedia({ mediaId: id() })],
];

const publishCalls: Call[] = [
  ["publishVersion", () => pagesActions.publishVersion({ versionId: id() })],
  ["publishVersion (schedule)", () => pagesActions.publishVersion({ versionId: id(), scheduleAt: new Date(Date.now() + 3_600_000).toISOString() })],
  ["cancelScheduledPublish", () => pagesActions.cancelScheduledPublish({ versionId: id() })],
  ["unpublishPage", () => pagesActions.unpublishPage({ pageId: id() })],
  ["archivePage", () => pagesActions.archivePage({ pageId: id() })],
  ["restoreArchivedPage", () => pagesActions.restoreArchivedPage({ pageId: id() })],
  ["updateNavMenu", () => navActions.updateNavMenu({ key: "header", items: [], expectedVersion: 0 })],
  ["upsertRedirect", () => redirectActions.upsertRedirect({ fromPath: "/nl/oud", to: { url: "/nl" }, isPermanent: true })],
  ["deleteRedirect", () => redirectActions.deleteRedirect({ id: id() })],
];

describe("site declares its permissions", () => {
  it("has site.edit and site.publish", () => {
    expect(permissions).toEqual(expect.arrayContaining(["site.edit", "site.publish"]));
  });
});

describe("P3 actions without the permission", () => {
  it.each(editCalls)("%s is forbidden without site.edit", async (_label, run) => {
    await staffSession(h.db, jar, ["site.publish", "reports.read"]);
    expect(await run()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it.each(publishCalls)("%s is forbidden without site.publish", async (_label, run) => {
    await staffSession(h.db, jar, ["site.edit", "ai.use"]);
    expect(await run()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it.each([...editCalls, ...publishCalls])("%s is unauthorized for a customer", async (_label, run) => {
    const user = await makeUser(h.db, { audience: "customer" });
    const { token } = await createAuthSession(h.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
    jar.set(SESSION_COOKIE, token);
    expect(await run()).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  });

  it("nothing was written by the refused calls", async () => {
    const rows = await h.db.select().from(pages);
    expect(rows.filter((r) => r.slug.startsWith("perm-"))).toEqual([]);
  });

  it("with site.edit and site.publish the same calls reach the handler", async () => {
    await staffSession(h.db, jar, ["site.edit", "site.publish"]);
    for (const [label, run] of [...editCalls, ...publishCalls]) {
      const res = (await run()) as { ok: boolean; error?: { code: string } };
      expect([label, res.ok ? "ok" : res.error!.code]).not.toEqual([label, "forbidden"]);
    }
  });
});

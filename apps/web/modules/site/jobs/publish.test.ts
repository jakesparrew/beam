/**
 * site-P3 `site.publish_version` (site spec section 4 jobs, rule 13, edge case 12): publishes at
 * run time, failed checks clear the schedule and audit `site.page.schedule_failed`, a changed
 * schedule makes the job a no-op (also when it changes between the job's read and the page lock),
 * and a double run yields one publish.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle } from "@beam/db";
import { auditLog, pageRoutes, pages, pageVersions } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import type * as Versions from "../server/versions";

vi.mock("next/cache", () => ({ revalidateTag: () => undefined, unstable_cache: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock("next/server", () => ({ after: () => undefined }));
// A stale read of the version (taken before the page lock), handed out once when set.
const stale = vi.hoisted((): { row: unknown } => ({ row: null }));
vi.mock("../server/versions", async (importOriginal) => {
  const real = await importOriginal<typeof Versions>();
  return {
    ...real,
    getVersionRow: async (...args: Parameters<typeof real.getVersionRow>) => {
      if (stale.row) {
        const row = stale.row as Awaited<ReturnType<typeof real.getVersionRow>>;
        stale.row = null;
        return row;
      }
      return real.getVersionRow(...args);
    },
  };
});

const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime, runJobTwice } = await import("@/lib/testing");
const { getContentIssues } = await import("../queries/admin");
const { publishable, slug } = await import("../site-p3.fixtures");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

async function scheduledDraft(content = publishable(slug("sched"))) {
  const at = new Date(Date.now() - 1000);
  const [p] = await h.db.insert(pages).values({ kind: "standard", slug: slug("sched") }).returning();
  const [v] = await h.db.insert(pageVersions).values({ pageId: p!.id, version: 1, state: "draft", ...content, scheduledPublishAt: at }).returning();
  return { pageId: p!.id, versionId: v!.id, at };
}

describe("site.publish_version", () => {
  it("publishes at run time; the second run changes nothing", async () => {
    const s = await scheduledDraft();
    const scheduler = randomUUID();
    const { first, second } = await runJobTwice(h.db, "site.publish_version", { versionId: s.versionId, scheduledPublishAt: s.at.toISOString(), scheduledByUserId: scheduler });
    expect(first).toMatchObject({ outcome: "published" });
    expect(second).toMatchObject({ outcome: "skipped", reason: "version_published" });
    expect((await h.db.select().from(pages).where(eq(pages.id, s.pageId)))[0]).toMatchObject({ status: "published", currentVersionId: s.versionId });
    expect(await h.db.select().from(pageVersions).where(eq(pageVersions.id, s.versionId))).toEqual([expect.objectContaining({ state: "published", publishedByUserId: null, scheduledPublishAt: null })]);
    expect(await h.db.select().from(pageRoutes).where(eq(pageRoutes.pageId, s.pageId))).toHaveLength(3);
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.page.publish"), eq(auditLog.entityId, s.pageId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.newValue).toMatchObject({ scheduledBy: scheduler });
    expect(["system", "job"]).toContain((audits[0]!.actor as { kind: string }).kind);
  });

  it("failed checks clear the schedule, audit schedule_failed and show on /admin/site", async () => {
    const content = publishable(slug("bad"));
    content.seo = {};
    const s = await scheduledDraft(content);
    const { first, second } = await runJobTwice(h.db, "site.publish_version", { versionId: s.versionId, scheduledPublishAt: s.at.toISOString() });
    expect(first).toMatchObject({ outcome: "failed" });
    expect(second).toMatchObject({ outcome: "skipped", reason: "schedule_changed" });
    const [v] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, s.versionId));
    expect(v).toMatchObject({ state: "draft", scheduledPublishAt: null });
    expect((await h.db.select().from(pages).where(eq(pages.id, s.pageId)))[0]!.status).toBe("draft");
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "site.page.schedule_failed"), eq(auditLog.entityId, s.versionId)));
    expect(audits).toHaveLength(1);
    expect(["system", "job"]).toContain((audits[0]!.actor as { kind: string }).kind);
    const issues = await getContentIssues(h.db);
    expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "schedule_failed", pageId: s.pageId, versionId: s.versionId })]));
  });

  it("does nothing when the schedule was moved or cancelled", async () => {
    const s = await scheduledDraft();
    const { first } = await runJobTwice(h.db, "site.publish_version", { versionId: s.versionId, scheduledPublishAt: new Date(s.at.getTime() - 60_000).toISOString() });
    expect(first).toMatchObject({ outcome: "skipped", reason: "schedule_changed" });
    expect((await h.db.select().from(pageVersions).where(eq(pageVersions.id, s.versionId)))[0]!.state).toBe("draft");
    const gone = await runJobTwice(h.db, "site.publish_version", { versionId: randomUUID(), scheduledPublishAt: s.at.toISOString() });
    expect(gone.first).toMatchObject({ outcome: "skipped", reason: "version_missing" });
  });
  it("re-checks the schedule under the page lock: a cancel or reschedule committed after the job's read wins", async () => {
    for (const change of [null, 3_600_000] as const) {
      const s = await scheduledDraft();
      const [before] = await h.db.select().from(pageVersions).where(eq(pageVersions.id, s.versionId));
      stale.row = before;
      // Staff cancel (or move) the schedule between the job's read and its page lock.
      await h.db
        .update(pageVersions)
        .set({ scheduledPublishAt: change === null ? null : new Date(s.at.getTime() + change) })
        .where(eq(pageVersions.id, s.versionId));
      const { first } = await runJobTwice(h.db, "site.publish_version", { versionId: s.versionId, scheduledPublishAt: s.at.toISOString() });
      expect(first).toMatchObject({ outcome: "skipped", reason: "schedule_changed" });
      expect((await h.db.select().from(pageVersions).where(eq(pageVersions.id, s.versionId)))[0]).toMatchObject({ state: "draft", publishedAt: null });
      expect((await h.db.select().from(pages).where(eq(pages.id, s.pageId)))[0]).toMatchObject({ status: "draft", currentVersionId: null });
      expect(await h.db.select().from(pageRoutes).where(eq(pageRoutes.pageId, s.pageId))).toHaveLength(0);
    }
  });
});

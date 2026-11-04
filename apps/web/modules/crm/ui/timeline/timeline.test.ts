/**
 * crm-P7 timeline (rules 3.26, 3.35 to 3.37) on PGlite: automation items merged by time, a merged
 * loser's history included, cursor paging stable with equal timestamps, the category filter, a
 * sensitive note stored encrypted and rendered as a placeholder, an unknown kind rendered raw,
 * and every registered kind prefix mapped to a category.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, persons } from "@beam/db/schema";
import type { AutomationTimelineItem } from "@beam/core/automation";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p7-timeline-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.7" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const automation = vi.hoisted(() => ({ items: new Map<string, AutomationTimelineItem[]>() }));
vi.mock("@/modules/automation/api", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    getTimelineItems: (_db: unknown, personId: string, opts: { before?: Date; limit?: number } = {}) =>
      Promise.resolve(
        (automation.items.get(personId) ?? [])
          .filter((i) => !opts.before || i.occurredAt < opts.before)
          .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
          .slice(0, opts.limit ?? 100),
      ),
  };
});

const { listTimeline, categoryOfKind, TIMELINE_PREFIX_CATEGORY } = await import("../../timeline/api");
const { toTimelineRows } = await import("../../timeline/queries");
const actions = await import("../../timeline/actions");
const auth = await import("@/lib/auth");
const { eq, setAppDb } = await import("@/lib/ctx");
const { recordEvent } = await import("@/lib/events");
const { decryptSensitive, sensitiveAad } = await import("@/lib/sensitive");
const { resetRuntime } = await import("@/lib/testing");
const { EVENTS } = await import("@/registry/events.generated");

let h: DbHandle;
const SYSTEM = { kind: "system" as const, id: null };

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(() => {
  jar.clear();
  automation.items.clear();
});

async function signIn(roleKey: "owner" | "customer_service") {
  const user = await makeUser(h.db, { roleKey });
  const { token } = await auth.createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  return user;
}

const at = (iso: string) => new Date(iso);
async function event(personId: string, kind: string, occurredAt: Date, data: Record<string, unknown> = {}) {
  const { id } = await recordEvent(h.db, SYSTEM, { kind: kind as never, personId, occurredAt, data });
  return id!.toString();
}

const autoItem = (occurredAt: Date, outcome: AutomationTimelineItem["outcome"] = "sent"): AutomationTimelineItem => ({
  id: randomUUID(),
  occurredAt,
  automationSlug: "welcome",
  automationName: "Welcome",
  stepKey: "mail_1",
  outcome,
  reason: null,
  endReason: null,
  emailMessageId: null,
  emailStatus: null,
  taskId: null,
});

describe("timeline (rules 3.35 to 3.37)", () => {
  it("3.37 merges automation items by time, newest first", async () => {
    const p = await makePerson(h.db);
    await event(p.id, "tag.added", at("2026-05-01T10:00:00Z"), { tag_key: "vip", source: "manual" });
    await event(p.id, "tag.removed", at("2026-05-03T10:00:00Z"), { tag_key: "vip", source: "manual" });
    automation.items.set(p.id, [autoItem(at("2026-05-02T10:00:00Z")), autoItem(at("2026-05-04T10:00:00Z"), "completed")]);
    const page = await listTimeline(h.db, { personId: p.id });
    expect(page.items.map((i) => i.kind)).toEqual(["automation.completed", "tag.removed", "automation.sent", "tag.added"]);
    expect(page.items.filter((i) => i.category === "automation")).toHaveLength(2);
    expect(page.nextBefore).toBeNull();
  });

  it("3.32 includes the history of a person merged into this one", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    await h.db.update(persons).set({ mergedIntoPersonId: winner.id }).where(eq(persons.id, loser.id));
    await event(winner.id, "tag.added", at("2026-05-01T09:00:00Z"), { tag_key: "a", source: "manual" });
    await event(loser.id, "tag.added", at("2026-05-02T09:00:00Z"), { tag_key: "b", source: "manual" });
    const page = await listTimeline(h.db, { personId: winner.id });
    expect(page.items.map((i) => i.personId)).toEqual([loser.id, winner.id]);
    const viaLoser = await listTimeline(h.db, { personId: loser.id });
    expect(viaLoser.items).toHaveLength(2);
  });

  it("3.37 cursor paging is stable when timestamps are equal", async () => {
    const p = await makePerson(h.db);
    const same = at("2026-06-01T12:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push(await event(p.id, "tag.added", same, { tag_key: `t${i}`, source: "manual" }));
    automation.items.set(p.id, [autoItem(same), autoItem(same)]);
    const seen: string[] = [];
    let before: { occurredAt: Date; id: string } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listTimeline(h.db, { personId: p.id, limit: 3, ...(before ? { before } : {}) });
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextBefore) break;
      before = page.nextBefore;
    }
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    // events first (newest id first), then the automation items
    expect(seen.slice(0, 7)).toEqual([...ids].sort((a, b) => Number(b) - Number(a)));
    expect(seen.slice(7).every((id) => id.startsWith("automation:"))).toBe(true);
  });

  it("3.37 filters by category, unmapped prefixes fall into profile", async () => {
    const p = await makePerson(h.db);
    await event(p.id, "consent.granted", at("2026-07-01T10:00:00Z"), { purpose: "newsletter", method: "form" });
    await event(p.id, "tag.added", at("2026-07-02T10:00:00Z"), { tag_key: "x", source: "manual" });
    await event(p.id, "interaction.logged", at("2026-07-03T10:00:00Z"), { channel: "call", purpose: "service", summary: "Called back" });
    automation.items.set(p.id, [autoItem(at("2026-07-04T10:00:00Z"))]);
    expect((await listTimeline(h.db, { personId: p.id, categories: ["consent"] })).items.map((i) => i.kind)).toEqual(["consent.granted"]);
    expect((await listTimeline(h.db, { personId: p.id, categories: ["service", "profile"] })).items.map((i) => i.kind)).toEqual(["interaction.logged", "tag.added"]);
    expect((await listTimeline(h.db, { personId: p.id, categories: ["automation"] })).items.map((i) => i.category)).toEqual(["automation"]);
    expect(categoryOfKind("unknownprefix.happened")).toBe("profile");
  });

  it("4.7 maps every registered kind prefix to a category", () => {
    const prefixes = new Set(Object.keys(EVENTS).map((k) => k.split(".")[0]!));
    for (const prefix of prefixes) expect(TIMELINE_PREFIX_CATEGORY[prefix], prefix).toBeDefined();
  });

  it("3.26 stores a sensitive note encrypted and renders it as a placeholder", async () => {
    await signIn("owner");
    const p = await makePerson(h.db);
    const body = `trouble sleeping ${randomUUID().slice(0, 6)}`;
    const result = await actions.addNote({ personId: p.id, body, isSensitive: true });
    expect(result.ok).toBe(true);
    const eventId = result.ok ? result.data.eventId : "";
    const [row] = await h.db.select().from(activityEvents).where(eq(activityEvents.id, BigInt(eventId)));
    expect(row!.isSensitive).toBe(true);
    expect(JSON.stringify(row!.data)).not.toContain(body);
    const data = row!.data as { body_enc: string; key_version: number };
    expect(decryptSensitive(Buffer.from(data.body_enc, "base64"), data.key_version, sensitiveAad.note(p.id))).toBe(body);

    const page = await listTimeline(h.db, { personId: p.id });
    const item = page.items.find((i) => i.id === eventId)!;
    expect(item.isSensitive).toBe(true);
    expect(item.data).toEqual({});
    const [view] = await toTimelineRows(h.db, [item], "en");
    expect(view!.summary).toBe("Sensitive note");
    expect(view!.detail).toBeNull();
    expect(JSON.stringify(view)).not.toContain(body);
  });

  it("3.26 refuses a sensitive note without persons.sensitive_read", async () => {
    await signIn("customer_service");
    const p = await makePerson(h.db);
    const result = await actions.addNote({ personId: p.id, body: "private", isSensitive: true });
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await h.db.select().from(activityEvents).where(eq(activityEvents.personId, p.id))).toHaveLength(0);
  });

  it("3.37 renders crm kinds through their summary and an unknown kind as its raw string", async () => {
    const p = await makePerson(h.db);
    await event(p.id, "consent.withdrawn", at("2026-08-01T10:00:00Z"), { purpose: "newsletter", method: "portal" });
    await h.db.insert(activityEvents).values({ kind: "legacy.something_odd", personId: p.id, actor: SYSTEM, data: {}, occurredAt: at("2026-08-02T10:00:00Z") });
    const page = await listTimeline(h.db, { personId: p.id });
    const rows = await toTimelineRows(h.db, page.items, "en");
    expect(rows.map((r) => [r.kind, r.summary, r.isUnknown])).toEqual([
      ["legacy.something_odd", "legacy.something_odd", true],
      ["consent.withdrawn", "Consent withdrawn for Newsletter", false],
    ]);
  });

  it("3.36 carries the mode of webinar-style activity", async () => {
    const p = await makePerson(h.db);
    await h.db.insert(activityEvents).values({ kind: "note.added", personId: p.id, actor: SYSTEM, data: { body: "x" }, mode: "replay" });
    const page = await listTimeline(h.db, { personId: p.id });
    expect(page.items[0]!.data.mode).toBe("replay");
    const [row] = await toTimelineRows(h.db, page.items, "en");
    expect(row!.modeLabel).toBeTruthy();
  });

  it("logInteraction writes interaction.logged and loadTimeline pages display rows", async () => {
    await signIn("owner");
    const p = await makePerson(h.db);
    const r = await actions.logInteraction({ personId: p.id, channel: "call", purpose: "reactivation", summary: "Asked about a membership" });
    expect(JSON.stringify(r)).toContain('"ok":true');
    const page = await actions.loadTimeline({ personId: p.id });
    expect(page.ok && page.data.rows.map((x) => x.kind)).toEqual(["interaction.logged"]);
    expect(page.ok && page.data.rows[0]!.summary).toContain("Asked about a membership");
  });
});

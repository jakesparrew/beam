/**
 * crm-P2 tags: system tags cannot be deleted, a person carries a tag at most once, and every
 * `tag.added` / `tag.removed` carries `data.source` naming who added or removed the tag.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, auditLog, personTags, tags } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p2-tags-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.31" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const actions = await import("./actions");
const api = await import("./api");
const { listTags } = await import("./queries");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { makeCtx, resetRuntime } = await import("@/lib/testing");

let h: DbHandle;
const NAME = { "nl-BE": "Ademwerk", "fr-BE": "Respiration", en: "Breathwork" };
const key = () => `t-${randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  const owner = await makeUser(h.db, { roleKey: "owner" });
  const { token } = await auth.createAuthSession(h.db, { userId: owner.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
});

const tx = () => h.db as unknown as Parameters<typeof api.applyTag>[0];
const eventsOf = (personId: string, kind: string) =>
  h.db
    .select()
    .from(activityEvents)
    .where(and(eq(activityEvents.personId, personId), eq(activityEvents.kind, kind)));

async function newTag(isSystem = false) {
  const [row] = await h.db.insert(tags).values({ key: key(), name: NAME, isSystem }).returning();
  return row!;
}

describe("tags", () => {
  it("creates, renames and recolours a tag; a name must exist in all three locales", async () => {
    const k = key();
    const created = await actions.createTag({ key: k, name: NAME, color: "#112233" });
    expect(created.ok).toBe(true);
    const id = (created as { data: { id: string } }).data.id;
    expect(await actions.createTag({ key: k, name: NAME, color: "#112233" })).toMatchObject({ ok: false, error: { code: "conflict", message: "tag_key_taken" } });
    expect(await actions.createTag({ key: key(), name: { en: "Only English" }, color: "#112233" })).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.updateTag({ id, key: k, name: { ...NAME, en: "Breath" }, color: "#445566" })).toEqual({ ok: true, data: { id } });
    const [row] = await h.db.select().from(tags).where(eq(tags.id, id));
    expect(row).toMatchObject({ color: "#445566", name: { en: "Breath" } });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "tag.update"), eq(auditLog.entityId, id)))).toHaveLength(1);
  });

  it("refuses to delete a system tag or change its key; deletes another tag with its assignments", async () => {
    const system = await newTag(true);
    expect(await actions.deleteTag({ id: system.id })).toMatchObject({ ok: false, error: { code: "conflict", message: "system_tag" } });
    expect(await actions.updateTag({ id: system.id, key: key(), name: NAME, color: "#64748b" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await h.db.select().from(tags).where(eq(tags.id, system.id))).toHaveLength(1);

    const plain = await newTag();
    const p = await makePerson(h.db);
    await api.applyTag(tx(), makeCtx(h.db), p.id, plain.key, "form");
    expect(await actions.deleteTag({ id: plain.id })).toEqual({ ok: true, data: {} });
    expect(await h.db.select().from(tags).where(eq(tags.id, plain.id))).toHaveLength(0);
    // the source is who removed the tag (staff deleting it), not the form that added it
    expect((await eventsOf(p.id, "tag.removed"))[0]!.data).toEqual({ tag_key: plain.key, source: "manual" });
  });

  it("a person carries a tag once; events carry data.source equal to the tag source", async () => {
    const tag = await newTag();
    const p = await makePerson(h.db);
    expect(await api.applyTag(tx(), makeCtx(h.db), p.id, tag.key, "automation")).toEqual({ applied: true });
    expect(await api.applyTag(tx(), makeCtx(h.db), p.id, tag.key, "manual")).toEqual({ applied: false });
    expect(await h.db.select().from(personTags).where(and(eq(personTags.personId, p.id), eq(personTags.tagId, tag.id)))).toHaveLength(1);
    expect((await eventsOf(p.id, "tag.added")).map((e) => e.data)).toEqual([{ tag_key: tag.key, source: "automation" }]);
    expect(await api.removeTag(tx(), makeCtx(h.db), p.id, tag.key, "import")).toEqual({ removed: true });
    expect(await api.removeTag(tx(), makeCtx(h.db), p.id, tag.key, "import")).toEqual({ removed: false });
    expect((await eventsOf(p.id, "tag.removed")).map((e) => e.data)).toEqual([{ tag_key: tag.key, source: "import" }]);
    await expect(api.applyTag(tx(), makeCtx(h.db), p.id, "no-such-tag", "import")).rejects.toMatchObject({ code: "not_found" });
  });

  it("tag.removed records who removed the tag, not who added it (A-7, fix-w09-crm-review)", async () => {
    const tag = await newTag();
    // staff added it; an automation's untag step (system actor, source 'automation') removes it
    const p = await makePerson(h.db);
    await api.applyTag(tx(), makeCtx(h.db), p.id, tag.key, "manual");
    expect(await api.removeTag(tx(), makeCtx(h.db), p.id, tag.key, "automation")).toEqual({ removed: true });
    expect((await eventsOf(p.id, "tag.removed")).map((e) => e.data)).toEqual([{ tag_key: tag.key, source: "automation" }]);
    // a caller that does not name the source: a system actor counts as an automation
    const q = await makePerson(h.db);
    await api.applyTag(tx(), makeCtx(h.db), q.id, tag.key, "manual");
    expect(await api.removeTag(tx(), makeCtx(h.db), q.id, tag.key)).toEqual({ removed: true });
    expect((await eventsOf(q.id, "tag.removed")).map((e) => e.data)).toEqual([{ tag_key: tag.key, source: "automation" }]);
    // staff untagging an imported tag records 'manual'
    const r = await makePerson(h.db);
    await api.applyTag(tx(), makeCtx(h.db), r.id, tag.key, "import");
    expect(await actions.untagPersons({ tagId: tag.id, personIds: [r.id] })).toEqual({ ok: true, data: { changed: 1 } });
    expect((await eventsOf(r.id, "tag.removed")).map((e) => e.data)).toEqual([{ tag_key: tag.key, source: "manual" }]);
  });

  it("bulk tag and untag change each person once, skip merged persons, and audit counts", async () => {
    const tag = await newTag();
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    const merged = await makePerson(h.db, { mergedIntoPersonId: a.id });
    expect(await actions.tagPersons({ tagId: tag.id, personIds: [a.id, b.id, merged.id] })).toEqual({ ok: true, data: { changed: 2 } });
    expect(await actions.tagPersons({ tagId: tag.id, personIds: [a.id, b.id] })).toEqual({ ok: true, data: { changed: 0 } });
    expect((await eventsOf(b.id, "tag.added"))[0]!.data).toEqual({ tag_key: tag.key, source: "manual" });
    expect((await listTags(h.db)).find((t) => t.id === tag.id)!.count).toBe(2);
    expect(await actions.untagPersons({ tagId: tag.id, personIds: [a.id] })).toEqual({ ok: true, data: { changed: 1 } });
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "tag.assign"), eq(auditLog.entityId, tag.id)));
    expect(audits).toHaveLength(3);
    expect(await actions.tagPersons({ tagId: tag.id, personIds: [] })).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

/**
 * crm-P5 segments (rules 3.38 to 3.41, edge cases 18 to 21 and 34): dynamic result, static list,
 * exclusions at read time, erased, merged and restricted persons excluded, `in_segment` cycles
 * refused, enter and leave events with dedupe, a second refresh writes nothing, a failing refresh
 * keeps the members and stores `refresh_error`, concurrent refreshes serialise on the advisory
 * lock, event rules over webinar mode and poll options, the archive guard and the jobs.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import { makePaidOrder } from "@beam/db/testing/commerce-factories";
import type { DbHandle, Tx } from "@beam/db";
import { activityEvents, auditLog, jobs, personTags, segmentMembers, segments, tags } from "@beam/db/schema";
import type { SegmentRule } from "@beam/core/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p5-segments-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.51" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

const automationInUse = { value: false };
vi.mock("@/modules/automation/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isSegmentInUse: vi.fn(() => Promise.resolve(automationInUse.value)),
}));

const actions = await import("./actions");
const api = await import("./api");
const queries = await import("./queries");
const segJobs = await import("./jobs");
const fixtures = await import("./test-fixtures");
const auth = await import("@/lib/auth");
const { and, eq, flushDurableWrites, inArray, setAppDb, sql } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");
const { makeCtx, makeJobCtx, resetRuntime, runJobTwice } = await import("@/lib/testing");

let h: DbHandle;
beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await fixtures.ensurePersonProfileView(h.db);
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  jar.clear();
  automationInUse.value = false;
  const owner = await makeUser(h.db, { roleKey: "owner" });
  const { token } = await auth.createAuthSession(h.db, { userId: owner.id, audience: "staff", roleKey: "owner", now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
});

const tx = () => h.db as unknown as Tx;
const NAME = { "nl-BE": "Label", "fr-BE": "Étiquette", en: "Label" };

async function newTag(): Promise<string> {
  const key = `seg-${randomUUID().slice(0, 8)}`;
  await h.db.insert(tags).values({ key, name: NAME });
  return key;
}
async function tagPerson(personId: string, key: string) {
  const [tag] = await h.db.select().from(tags).where(eq(tags.key, key));
  await h.db.insert(personTags).values({ personId, tagId: tag!.id, source: "manual", addedBy: { kind: "system", id: null } });
}
async function untagPerson(personId: string, key: string) {
  const [tag] = await h.db.select().from(tags).where(eq(tags.key, key));
  await h.db.delete(personTags).where(and(eq(personTags.personId, personId), eq(personTags.tagId, tag!.id)));
}
const members = async (segmentId: string) =>
  (await h.db.select({ id: segmentMembers.personId }).from(segmentMembers).where(eq(segmentMembers.segmentId, segmentId))).map((r) => r.id).sort();
const audience = async (segmentId: string, exclude?: string[]) =>
  rowsOf<{ person_id: string }>(await h.db.execute(api.segmentAudienceSql(segmentId, exclude)))
    .map((r) => r.person_id)
    .sort();
const segmentEvents = (segmentId: string) =>
  h.db
    .select()
    .from(activityEvents)
    .where(and(inArray(activityEvents.kind, ["segment.entered", "segment.left"]), eq(activityEvents.refId, segmentId)));
const sorted = (...ids: string[]) => [...ids].sort();
const ok = <T>(r: { ok: boolean; data?: T }): T => {
  expect(r).toMatchObject({ ok: true });
  return r.data as T;
};

async function saveDynamic(rule: SegmentRule, extra: { excludeSegmentIds?: string[]; id?: string; name?: string } = {}) {
  return actions.saveSegment({ name: extra.name ?? "Dynamic", kind: "dynamic", definition: rule, excludeSegmentIds: extra.excludeSegmentIds ?? [], ...(extra.id ? { id: extra.id } : {}) });
}

describe("dynamic segments", () => {
  it("save computes the rule result, writes one entered event per member and audits", async () => {
    const key = await newTag();
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    await makePerson(h.db);
    await tagPerson(a.id, key);
    await tagPerson(b.id, key);
    const { id, count } = ok<{ id: string; count: number | null }>(await saveDynamic(fixtures.tagRule(key)));
    expect(count).toBe(2);
    expect(await members(id)).toEqual(sorted(a.id, b.id));
    const events = await segmentEvents(id);
    expect(events.map((e) => [e.kind, e.personId]).sort()).toEqual(sorted(a.id, b.id).map((p) => ["segment.entered", p]));
    expect(events[0]!.data).toEqual({ segment_id: id });
    expect(events[0]!.dedupeKey).toMatch(new RegExp(`^segment:${id}:enter:[0-9a-f-]{36}:\\d{4}-\\d{2}-\\d{2}T\\d{2}$`));
    const [seg] = await h.db.select().from(segments).where(eq(segments.id, id));
    expect(seg).toMatchObject({ lastCount: 2, refreshError: null });
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.action, "segment.save"), eq(auditLog.entityId, id)))).toHaveLength(1);
  });

  it("a second refresh with no change writes nothing; a departure writes one left event", async () => {
    const key = await newTag();
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    await tagPerson(a.id, key);
    await tagPerson(b.id, key);
    const id = await fixtures.insertSegment(h.db, { definition: fixtures.tagRule(key) });
    const ctx = makeCtx(h.db);
    expect(await api.refreshSegment(tx(), ctx, id, "manual")).toEqual({ count: 2, entered: 2, left: 0 });
    expect(await api.refreshSegment(tx(), ctx, id, "manual")).toEqual({ count: 2, entered: 0, left: 0 });
    expect(await segmentEvents(id)).toHaveLength(2);

    await untagPerson(b.id, key);
    expect(await api.refreshSegment(tx(), ctx, id, "campaign")).toEqual({ count: 1, entered: 0, left: 1 });
    const left = (await segmentEvents(id)).filter((e) => e.kind === "segment.left");
    expect(left.map((e) => e.personId)).toEqual([b.id]);
    expect(left[0]!.dedupeKey).toBe(`segment:${id}:leave:${b.id}:${api.hourBucket(ctx.now)}`);
    expect(await members(id)).toEqual([a.id]);
  });

  it("erased, merged and restricted persons are never members; one erased later leaves the audience at read time", async () => {
    const key = await newTag();
    const live = await makePerson(h.db);
    const erased = await makePerson(h.db, { erasedAt: new Date() });
    const merged = await makePerson(h.db, { mergedIntoPersonId: live.id });
    const restricted = await makePerson(h.db, { processingRestrictedAt: new Date() });
    const later = await makePerson(h.db);
    for (const p of [live, erased, merged, restricted, later]) await tagPerson(p.id, key);
    const id = await fixtures.insertSegment(h.db, { definition: fixtures.tagRule(key) });
    await api.refreshSegment(tx(), makeCtx(h.db), id, "manual");
    expect(await members(id)).toEqual(sorted(live.id, later.id));

    await h.db.execute(sql`update persons set processing_restricted_at = now() where id = ${later.id}::uuid`);
    expect(await audience(id)).toEqual([live.id]);
    expect(await api.isInSegment(h.db, id, later.id)).toBe(false);
    expect(await api.isInSegment(h.db, id, live.id)).toBe(true);
    expect(await api.isInSegment(h.db, id, merged.id)).toBe(true); // a merged id resolves to its winner
  });

  it("field rules read v_person_profile: a paid order makes a person a customer", async () => {
    const key = await newTag();
    const buyer = await makePerson(h.db);
    const lead = await makePerson(h.db);
    await tagPerson(buyer.id, key);
    await tagPerson(lead.id, key);
    await makePaidOrder(h.db, { personId: buyer.id, lines: [{ productKind: "session" }] });
    const rule: SegmentRule = { op: "and", rules: [{ type: "tag", tagKey: key, has: true }, { type: "field", field: "status", cmp: "eq", value: "customer" }] };
    const { id } = ok<{ id: string }>(await saveDynamic(rule));
    expect(await members(id)).toEqual([buyer.id]);
    const notLead: SegmentRule = { op: "and", rules: [{ type: "tag", tagKey: key, has: true }, { type: "not", rule: { type: "field", field: "status", cmp: "in", value: ["customer", "member"] } }] };
    const preview = await queries.previewSegment(h.db, { definition: notLead, excludeIds: [] });
    expect(preview.count).toBe(1);
    expect(preview.sample.map((s) => s.id)).toEqual([lead.id]);
    expect(preview.sample[0]!.customerNumber).toMatch(/^C-\d{6,}$/);
  });

  it("refuses unknown fields, comparators and rule limits with a validation error naming the path", async () => {
    const bad = await saveDynamic({ op: "and", rules: [{ type: "field", field: "email", cmp: "eq", value: "x" }] });
    expect(bad).toMatchObject({ ok: false, error: { code: "validation", fields: { "rules[0]": expect.stringContaining("unknown field") } } });
    const tooMany: SegmentRule = { op: "and", rules: Array.from({ length: 51 }, () => ({ type: "tag", tagKey: "vip", has: true })) };
    expect(await saveDynamic(tooMany)).toMatchObject({ ok: false, error: { code: "validation" } });
    expect(await actions.previewSegmentRule({ definition: { op: "and", rules: [{ type: "field", field: "status", cmp: "gt", value: 1 }] }, excludeIds: [] })).toMatchObject({
      ok: false,
      error: { code: "validation" },
    });
  });
});

describe("event rules", () => {
  async function event(personId: string, kind: string, data: Record<string, unknown>, mode?: "live" | "replay" | "on_demand") {
    await h.db.insert(activityEvents).values({ personId, kind, data, mode: mode ?? null, actor: { kind: "system", id: null } });
  }

  it("filter webinar attendance by mode, poll answers by option and watch time by range", async () => {
    const key = await newTag();
    const live = await makePerson(h.db);
    const replay = await makePerson(h.db);
    for (const p of [live, replay]) await tagPerson(p.id, key);
    await event(live.id, "webinar.attended", {}, "live");
    await event(replay.id, "webinar.attended", {}, "replay");
    await event(live.id, "webinar.poll_answered", { poll_key: "sleep", option_keys: ["a", "b"], option_key: null }, "live");
    await event(replay.id, "webinar.poll_answered", { poll_key: "sleep", option_keys: ["c"], option_key: "c" }, "replay");
    await event(replay.id, "webinar.watched", { threshold: 75, watched_sec: 2400 }, "replay");
    const scoped = (rule: SegmentRule): SegmentRule => ({ op: "and", rules: [{ type: "tag", tagKey: key, has: true }, rule] });
    const ids = async (rule: SegmentRule) => (await queries.previewSegment(h.db, { definition: scoped(rule), excludeIds: [] })).sample.map((s) => s.id).sort();

    expect(await ids({ type: "event", kind: "webinar.attended", mode: "live" })).toEqual([live.id]);
    expect(await ids({ type: "event", kind: "webinar.attended" })).toEqual(sorted(live.id, replay.id));
    expect(await ids({ type: "event", kind: "webinar.poll_answered", where: { poll_key: "sleep", option_keys: "a" } })).toEqual([live.id]);
    expect(await ids({ type: "event", kind: "webinar.poll_answered", where: { option_key: "c" } })).toEqual([replay.id]);
    expect(await ids({ type: "event", kind: "webinar.watched", where: { watched_sec: { gte: 1800 } } })).toEqual([replay.id]);
    expect(await ids({ type: "event", kind: "webinar.attended", mode: "replay", negate: true })).toEqual([live.id]);
    expect(await ids({ type: "event", kind: "webinar.attended", minCount: 2 })).toEqual([]);
  });

  it("an event of a merged loser counts for the winner", async () => {
    const key = await newTag();
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db, { mergedIntoPersonId: winner.id });
    await tagPerson(winner.id, key);
    await event(loser.id, "email.clicked", { link_index: 0, url: "https://example.com" });
    const rule: SegmentRule = { op: "and", rules: [{ type: "tag", tagKey: key, has: true }, { type: "event", kind: "email.clicked", withinDays: 30 }] };
    expect((await queries.previewSegment(h.db, { definition: rule, excludeIds: [] })).sample.map((s) => s.id)).toEqual([winner.id]);
  });
});

describe("static segments and exclusions", () => {
  it("a static segment is its manual list minus erased persons; enter and leave events are written", async () => {
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    const erased = await makePerson(h.db, { erasedAt: new Date() });
    const { id } = ok<{ id: string }>(await actions.saveSegment({ name: "VIP list", kind: "static", definition: { op: "and", rules: [] }, excludeSegmentIds: [] }));
    expect(ok(await actions.setStaticMembers({ segmentId: id, add: [a.id, b.id, erased.id], remove: [] }))).toEqual({ added: 2, removed: 0 });
    expect(ok(await actions.setStaticMembers({ segmentId: id, add: [a.id], remove: [b.id] }))).toEqual({ added: 0, removed: 1 });
    expect(await members(id)).toEqual([a.id]);
    expect((await segmentEvents(id)).map((e) => `${e.kind}:${e.personId}`).sort()).toEqual([`segment.entered:${a.id}`, `segment.entered:${b.id}`, `segment.left:${b.id}`].sort());
    // A refresh never recomputes a static list.
    expect(await api.refreshSegment(tx(), makeCtx(h.db), id, "manual")).toEqual({ count: 1, entered: 0, left: 0 });
    const dynamic = ok<{ id: string }>(await saveDynamic({ op: "and", rules: [] }));
    expect(await actions.setStaticMembers({ segmentId: dynamic.id, add: [a.id], remove: [] })).toMatchObject({ ok: false, error: { code: "conflict", message: "segment_not_static" } });
    const found = ok(await actions.findSegmentPersons({ customerNumbers: [`C-${String(a.customerNumber).padStart(6, "0")}`, "999999999", "nonsense"] }));
    expect(found).toEqual({ persons: [], ids: [a.id], unknown: ["nonsense", "999999999"] });
  });

  it("exclusions apply at read time without refreshing the including segment", async () => {
    const key = await newTag();
    const a = await makePerson(h.db);
    const b = await makePerson(h.db);
    for (const p of [a, b]) await tagPerson(p.id, key);
    const blocked = ok<{ id: string }>(await actions.saveSegment({ name: "Blocked", kind: "static", definition: { op: "and", rules: [] }, excludeSegmentIds: [] })).id;
    const main = ok<{ id: string; count: number | null }>(await saveDynamic(fixtures.tagRule(key), { excludeSegmentIds: [blocked] }));
    expect(main.count).toBe(2);
    ok(await actions.setStaticMembers({ segmentId: blocked, add: [b.id], remove: [] }));
    expect(await audience(main.id)).toEqual([a.id]);
    expect(await members(main.id)).toEqual(sorted(a.id, b.id)); // raw set unchanged
    expect(await api.isInSegment(h.db, main.id, b.id)).toBe(false);
    const other = ok<{ id: string }>(await actions.saveSegment({ name: "Other", kind: "static", definition: { op: "and", rules: [] }, excludeSegmentIds: [] })).id;
    ok(await actions.setStaticMembers({ segmentId: other, add: [a.id], remove: [] }));
    expect(await audience(main.id, [other])).toEqual([]);
    // Mutual exclusion is allowed (one level).
    expect(await actions.saveSegment({ id: blocked, name: "Blocked", kind: "static", definition: { op: "and", rules: [] }, excludeSegmentIds: [main.id] })).toMatchObject({ ok: true });
  });

  it("in_segment references are checked: unknown, self and cycles are refused", async () => {
    const a = ok<{ id: string }>(await saveDynamic({ op: "and", rules: [] }, { name: "A" })).id;
    const b = ok<{ id: string }>(await saveDynamic({ op: "and", rules: [{ type: "in_segment", segmentId: a }] }, { name: "B" })).id;
    const cycle = await saveDynamic({ op: "and", rules: [{ type: "in_segment", segmentId: b }] }, { id: a, name: "A" });
    expect(cycle).toMatchObject({ ok: false, error: { code: "validation", message: "segment_cycle" } });
    expect(await saveDynamic({ type: "in_segment", segmentId: a }, { id: a })).toMatchObject({ ok: false, error: { code: "validation", message: "segment_cycle" } });
    expect(await saveDynamic({ type: "in_segment", segmentId: randomUUID() })).toMatchObject({ ok: false, error: { code: "validation", message: "invalid_segment_reference" } });
    expect(await saveDynamic({ op: "and", rules: [] }, { id: a, excludeSegmentIds: [a] })).toMatchObject({ ok: false, error: { code: "validation" } });
  });
});

describe("refresh failures, locking and jobs", () => {
  it("a failing refresh keeps the members, stores refresh_error and retries; the next good refresh clears it", async () => {
    const key = await newTag();
    const a = await makePerson(h.db);
    await tagPerson(a.id, key);
    const id = await fixtures.insertSegment(h.db, { definition: fixtures.tagRule(key) });
    await api.refreshSegment(tx(), makeCtx(h.db), id, "manual");
    await h.db.update(segments).set({ definition: { op: "and", rules: [{ type: "field", field: "not_a_column", cmp: "eq", value: "x" }] } }).where(eq(segments.id, id));

    let jobCtx: ReturnType<typeof makeJobCtx> | undefined;
    const run = h.db.transaction(async (t) => {
      jobCtx = makeJobCtx(h.db, "segments.refresh_one", { tx: t });
      await segJobs.runRefreshSegment(jobCtx, { segmentId: id, reason: "schedule" });
    });
    await expect(run).rejects.toMatchObject({ name: "RetryableError" });
    await flushDurableWrites(h.db, jobCtx!);
    const [seg] = await h.db.select().from(segments).where(eq(segments.id, id));
    expect(seg!.refreshError).toMatch(/not_a_column/);
    expect(await members(id)).toEqual([a.id]);
    expect(await api.countSegmentRefreshErrors(h.db)).toBeGreaterThanOrEqual(1);

    await h.db.update(segments).set({ definition: fixtures.tagRule(key) }).where(eq(segments.id, id));
    await runJobTwice(h.db, "segments.refresh_one", { segmentId: id, reason: "schedule" });
    const [fixed] = await h.db.select().from(segments).where(eq(segments.id, id));
    expect(fixed).toMatchObject({ refreshError: null, lastCount: 1 });
  });

  it("two concurrent refreshes serialise on the advisory lock and leave one set of events", async () => {
    const key = await newTag();
    const people = await Promise.all([makePerson(h.db), makePerson(h.db), makePerson(h.db)]);
    for (const p of people) await tagPerson(p.id, key);
    const id = await fixtures.insertSegment(h.db, { definition: fixtures.tagRule(key) });
    const locks: number[] = [];
    const refresh = () =>
      h.db.transaction(async (t) => {
        const result = await api.refreshSegment(t, makeCtx(h.db), id, "manual");
        const [row] = rowsOf<{ n: number }>(await t.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted`));
        locks.push(Number(row!.n));
        return result;
      });
    const [one, two] = await Promise.all([refresh(), refresh()]);
    expect(one.entered + two.entered).toBe(3);
    expect(Math.min(one.entered, two.entered)).toBe(0);
    expect(locks.every((n) => n >= 1)).toBe(true);
    expect(await segmentEvents(id)).toHaveLength(3);
    expect(await members(id)).toEqual(sorted(...people.map((p) => p.id)));
  });

  it("segments.refresh enqueues one refresh per non-archived dynamic segment; both jobs are idempotent", async () => {
    const key = await newTag();
    const a = await makePerson(h.db);
    await tagPerson(a.id, key);
    const dyn = await fixtures.insertSegment(h.db, { definition: fixtures.tagRule(key) });
    const archived = await fixtures.insertSegment(h.db, { definition: fixtures.tagRule(key), isArchived: true });
    const stat = await fixtures.insertSegment(h.db, { kind: "static" });
    await runJobTwice(h.db, "segments.refresh", {});
    const queued = await h.db.select().from(jobs).where(eq(jobs.kind, "segments.refresh_one"));
    const forSegment = (sid: string) => queued.filter((j) => (j.payload as { segmentId: string }).segmentId === sid);
    expect(forSegment(dyn)).toHaveLength(1);
    expect(forSegment(dyn)[0]!.idempotencyKey).toMatch(new RegExp(`^segment:${dyn}:refresh:\\d{4}-\\d{2}-\\d{2}T\\d{2}$`));
    expect(forSegment(archived)).toHaveLength(0);
    expect(forSegment(stat)).toHaveLength(0);

    const { first, second } = await runJobTwice(h.db, "segments.refresh_one", { segmentId: dyn, reason: "schedule" });
    expect(first).toEqual({ count: 1, entered: 1, left: 0 });
    expect(second).toEqual({ count: 1, entered: 0, left: 0 });
    expect(await segmentEvents(dyn)).toHaveLength(1);
  });

  it("refreshSegmentNow enqueues a manual refresh", async () => {
    const id = await fixtures.insertSegment(h.db, {});
    const { jobId } = ok<{ jobId: string }>(await actions.refreshSegmentNow({ segmentId: id }));
    const [job] = await h.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(job).toMatchObject({ kind: "segments.refresh_one", payload: { segmentId: id, reason: "manual" } });
    expect(job!.idempotencyKey).toMatch(new RegExp(`^segment:${id}:refresh:manual:req_`));
  });
});

describe("archive guard and reads", () => {
  it("archives an unused segment; refuses one used by an automation or another segment", async () => {
    const free = await fixtures.insertSegment(h.db, { name: "Free" });
    expect(ok(await actions.archiveSegment({ id: free }))).toEqual({});
    expect(await api.getSegmentRef(h.db, free)).toMatchObject({ id: free, isArchived: true, kind: "dynamic" });
    expect((await api.getSegmentSummaries(h.db)).map((s) => s.id)).not.toContain(free);
    expect((await queries.listSegments(h.db, { includeArchived: true })).map((s) => s.id)).toContain(free);
    expect((await queries.listSegments(h.db, { includeArchived: false })).map((s) => s.id)).not.toContain(free);

    const used = await fixtures.insertSegment(h.db, { name: "Used" });
    automationInUse.value = true;
    expect(await actions.archiveSegment({ id: used })).toMatchObject({ ok: false, error: { code: "conflict", message: "segment_in_use" } });
    automationInUse.value = false;
    await fixtures.insertSegment(h.db, { name: "Includer", definition: { op: "and", rules: [{ type: "in_segment", segmentId: used }] } });
    expect(await actions.archiveSegment({ id: used })).toMatchObject({ ok: false, error: { code: "conflict", message: "segment_in_use" } });
    expect(await actions.saveSegment({ id: free, name: "Free", kind: "dynamic", definition: { op: "and", rules: [] }, excludeSegmentIds: [] })).toMatchObject({
      ok: false,
      error: { code: "conflict", message: "segment_archived" },
    });
    expect(await api.getSegmentRef(h.db, randomUUID())).toBeNull();
    expect(await queries.getSegment(h.db, used)).toMatchObject({ id: used, name: "Used", kind: "dynamic" });
  });
});

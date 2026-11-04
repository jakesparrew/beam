/**
 * crm-P4 person merge (crm rules 3.30 to 3.34) on PGlite through the `mergePersons` action with a
 * signed-in owner. The owner hooks (webinar, credits) and automation's exit are spies; platform's
 * `reassignCustomerAccount` runs for real behind a spy.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeSession, makeUser } from "@beam/db/testing";
import { makeOrder } from "@beam/db/testing/commerce-factories";
import { makeCreditGrant, makeMembership } from "@beam/db/testing/credits-factories";
import type { DbHandle } from "@beam/db";
import {
  activityEvents,
  auditLog,
  bookings,
  consentRecords,
  creditGrants,
  memberships,
  orders,
  personDuplicateCandidates,
  personMerges,
  persons,
  personTags,
  tags,
  tasks,
  users,
} from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p4-merge-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.43" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));

type Call = { name: string; loserTagsOnLoser: number };
const hooks = vi.hoisted(() => ({ calls: [] as Call[], loserId: "" }));
async function loserTags(tx: { execute: (q: unknown) => Promise<unknown> }): Promise<number> {
  const { sql } = await import("drizzle-orm");
  const res = (await tx.execute(sql`select count(*)::int as n from person_tags where person_id = ${hooks.loserId}`)) as { rows: { n: number }[] };
  return Number(res.rows[0]?.n ?? 0);
}
const spies = vi.hoisted(() => ({
  webinar: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
  credits: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
  exit: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
  reassign: undefined as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));
vi.mock("@/modules/webinar/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/webinar/api")>();
  spies.webinar = vi.fn(async (tx: never) => {
    hooks.calls.push({ name: "webinar", loserTagsOnLoser: await loserTags(tx) });
    return { moved: 0, collapsed: 0 };
  });
  return { ...real, mergePersons: spies.webinar };
});
vi.mock("@/modules/credits/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/credits/api")>();
  spies.credits = vi.fn(async (tx: never) => {
    hooks.calls.push({ name: "credits", loserTagsOnLoser: await loserTags(tx) });
  });
  return { ...real, onPersonsMerged: spies.credits };
});
vi.mock("@/modules/automation/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/automation/api")>();
  spies.exit = vi.fn(() => Promise.resolve({ exited: 0 }));
  return { ...real, exitPersonEnrolments: spies.exit };
});
vi.mock("@/modules/platform/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/modules/platform/api")>();
  spies.reassign = vi.fn(real.reassignCustomerAccount);
  return { ...real, reassignCustomerAccount: spies.reassign };
});

const actions = await import("./actions");
const queries = await import("./queries");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { resetRuntime } = await import("@/lib/testing");
const { resolvePersonIds } = await import("@/modules/crm/persons/api");

let h: DbHandle;
let owner: { id: string };

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
  hooks.calls = [];
  for (const s of Object.values(spies)) s.mockClear();
  owner = await signIn("owner");
});

async function signIn(roleKey: "owner" | "reception") {
  const user = await makeUser(h.db, { roleKey });
  const { token } = await auth.createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  return user;
}

const person = async (id: string) => (await h.db.select().from(persons).where(eq(persons.id, id)))[0]!;
const merge = async (winnerId: string, loserId: string, fieldChoices: Record<string, "winner" | "loser"> = {}) => {
  hooks.loserId = loserId;
  const [w, l] = [await person(winnerId), await person(loserId)];
  return actions.mergePersons({ winnerId, loserId, winnerVersion: w.version, loserVersion: l.version, fieldChoices });
};
const day = (n: number) => new Date(Date.UTC(2026, 0, n, 9));
const consent = (personId: string, purpose: "newsletter" | "events", status: "granted" | "withdrawn", recordedAt: Date) =>
  h.db
    .insert(consentRecords)
    .values({ personId, purpose, status, method: "portal", source: "portal", wordingVersion: `${purpose}@1`, recordedAt, actor: { kind: "system" } })
    .returning()
    .then((r) => r[0]!);
const makeTag = async (_db: unknown) =>
  (await h.db.insert(tags).values({ key: `t-${randomUUID().slice(0, 8)}`, name: { en: "T", "nl-BE": "T", "fr-BE": "T" } }).returning())[0]!;
const tagged = async (personId: string, tagId: string) => h.db.insert(personTags).values({ personId, tagId, source: "manual", addedBy: { kind: "system" } });

describe("merge (rules 3.30 to 3.34)", () => {
  it("3.30 merges in one transaction: hooks first, generic repoint, candidates merged, login moved, automations exited, audit and events", async () => {
    const loser = await makePerson(h.db, {
      firstName: "Loser",
      email: `loser-${randomUUID().slice(0, 8)}@example.com`,
      isTester: true,
      acquisition: { source: "webinar", captured_at: "2025-01-01T00:00:00.000Z" },
      externalIds: { simplybook: "sb-1", mailchimp: "mc-loser" },
      processingRestrictedAt: day(3),
      createdAt: day(1),
    });
    const winner = await makePerson(h.db, { firstName: "Winner", isTester: false, acquisition: { source: "manual" }, externalIds: { mailchimp: "mc-winner" }, createdAt: day(2) });
    const shared = await makeTag(h.db);
    const own = await makeTag(h.db);
    await tagged(winner.id, shared.id);
    await tagged(loser.id, shared.id);
    await tagged(loser.id, own.id);
    const [task] = await h.db.insert(tasks).values({ ownerUserId: owner.id, personId: loser.id, title: "Call back", kind: "call", createdBy: { kind: "system" } }).returning();
    const order = await makeOrder(h.db, { personId: loser.id });
    const grant = await makeCreditGrant(h.db, { personId: loser.id });
    const account = await makeUser(h.db, { audience: "customer", personId: loser.id });
    const chained = await makePerson(h.db, { mergedIntoPersonId: loser.id });
    const [a, b] = [winner.id, loser.id].sort();
    const [candidate] = await h.db.insert(personDuplicateCandidates).values({ personAId: a!, personBId: b!, score: 90, reasons: ["email_variant"] }).returning();
    await h.db.insert(activityEvents).values({ personId: loser.id, kind: "person.created", actor: { kind: "system" }, data: {} });

    const res = await merge(winner.id, loser.id, { firstName: "loser", email: "loser" });
    expect(res.ok).toBe(true);
    const { mergeId, repointed } = (res as { data: { mergeId: string; repointed: Record<string, number> } }).data;

    // hooks: webinar then credits, once each, before the generic repoint touched person_tags
    expect(hooks.calls.map((c) => c.name)).toEqual(["webinar", "credits"]);
    expect(hooks.calls.every((c) => c.loserTagsOnLoser === 2)).toBe(true);
    expect(spies.webinar).toHaveBeenCalledTimes(1);
    expect(spies.webinar.mock.calls[0]!.slice(1)).toEqual([winner.id, loser.id]);
    expect(spies.credits).toHaveBeenCalledTimes(1);
    expect(spies.credits.mock.calls[0]![2]).toEqual({ winnerPersonId: winner.id, loserPersonId: loser.id });
    expect(repointed).toMatchObject({ "hook:webinar.moved": 0, "hook:credits": 1 });

    // generic repoint: mutable rows move, unique keys keep the winner's row
    expect((await h.db.select().from(tasks).where(eq(tasks.id, task!.id)))[0]!.personId).toBe(winner.id);
    expect((await h.db.select().from(orders).where(eq(orders.id, order.id)))[0]!.personId).toBe(winner.id);
    const winnerTags = await h.db.select().from(personTags).where(eq(personTags.personId, winner.id));
    expect(winnerTags.map((t) => t.tagId).sort()).toEqual([shared.id, own.id].sort());
    expect(await h.db.select().from(personTags).where(eq(personTags.personId, loser.id))).toHaveLength(0);
    expect(repointed).toMatchObject({ "tasks.person_id": 1, "orders.person_id": 1, "person_tags.person_id": 1, "person_tags.person_id:deleted": 1 });

    // credits tables are the hook's: never touched by the generic repoint
    expect((await h.db.select().from(creditGrants).where(eq(creditGrants.id, grant.id)))[0]!.personId).toBe(loser.id);
    expect(Object.keys(repointed).some((k) => k.startsWith("credit_grants") || k.startsWith("memberships") || k.startsWith("webinar_registrations"))).toBe(false);

    // append-only rows stay and are resolved
    expect(await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, loser.id), eq(activityEvents.kind, "person.created")))).toHaveLength(1);
    expect(await resolvePersonIds(h.db, winner.id)).toEqual(expect.arrayContaining([winner.id, loser.id, chained.id]));
    expect(await resolvePersonIds(h.db, loser.id)).toEqual(expect.arrayContaining([winner.id, loser.id]));

    // persons: loser and chain point at the winner; field choices and rule 3.34
    const [w, l, c] = [await person(winner.id), await person(loser.id), await person(chained.id)];
    expect(l.mergedIntoPersonId).toBe(winner.id);
    expect(c.mergedIntoPersonId).toBe(winner.id);
    expect(w).toMatchObject({ firstName: "Loser", email: loser.email, isTester: true, acquisition: loser.acquisition, externalIds: { simplybook: "sb-1", mailchimp: "mc-winner" } });
    expect(w.processingRestrictedAt?.toISOString()).toBe(day(3).toISOString());
    expect(w.version).toBe(winner.version + 1);
    expect(w.mergedIntoPersonId).toBeNull();

    // bookkeeping
    const [m] = await h.db.select().from(personMerges).where(eq(personMerges.id, mergeId));
    expect(m).toMatchObject({ winnerPersonId: winner.id, loserPersonId: loser.id, mergedByUserId: owner.id, fieldChoices: { firstName: "loser", email: "loser" } });
    expect(m!.loserSnapshot).toMatchObject({ id: loser.id, firstName: "Loser" });
    expect((await h.db.select().from(personDuplicateCandidates).where(eq(personDuplicateCandidates.id, candidate!.id)))[0]).toMatchObject({ status: "merged", reviewedByUserId: owner.id });

    // platform and automation, once each
    expect(spies.reassign).toHaveBeenCalledTimes(1);
    expect(spies.reassign.mock.calls[0]![1]).toEqual({ fromPersonId: loser.id, toPersonId: winner.id });
    expect((await h.db.select().from(users).where(eq(users.id, account.id)))[0]!.personId).toBe(winner.id);
    expect(spies.exit).toHaveBeenCalledTimes(1);
    expect(spies.exit.mock.calls[0]![1]).toMatchObject({ personId: loser.id, reason: "merged", actor: { kind: "staff", userId: owner.id } });

    // audit and events
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.action, "person.merge"), eq(auditLog.entityId, winner.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.oldValue).toEqual({ winner: { id: winner.id, version: winner.version }, loser: { id: loser.id, version: loser.version } });
    expect(await h.db.select().from(auditLog).where(eq(auditLog.action, "crm.merge_persons"))).toHaveLength(0);
    for (const [pid, role, other] of [
      [winner.id, "winner", loser.id],
      [loser.id, "loser", winner.id],
    ] as const) {
      const ev = await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, pid), eq(activityEvents.kind, "person.merged")));
      expect(ev.map((e) => e.data)).toEqual([{ merge_id: mergeId, role, other_person_id: other }]);
    }
  });

  it("3.31 both persons with an active membership are refused and nothing changes", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    await makeMembership(h.db, { personId: winner.id });
    await makeMembership(h.db, { personId: loser.id, status: "past_due" });
    const tag = await makeTag(h.db);
    await tagged(loser.id, tag.id);
    const res = await merge(winner.id, loser.id);
    expect(res).toMatchObject({ ok: false, error: { code: "conflict", message: "both_active_membership" } });
    expect((await person(loser.id)).mergedIntoPersonId).toBeNull();
    expect(await h.db.select().from(personMerges).where(eq(personMerges.loserPersonId, loser.id))).toHaveLength(0);
    expect(await h.db.select().from(personTags).where(eq(personTags.personId, loser.id))).toHaveLength(1);
    expect(await h.db.select().from(memberships).where(eq(memberships.personId, loser.id))).toHaveLength(1);
    expect(spies.webinar).not.toHaveBeenCalled();
    expect(spies.exit).not.toHaveBeenCalled();
    const preview = await queries.getMergePreview(h.db, winner.id, loser.id);
    expect(preview.conflicts).toEqual(["membership"]);
  });

  it("3.31 both persons booked on one session are refused; a cancelled booking on it moves only when it does not collide", async () => {
    const session = await makeSession(h.db);
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    await h.db.insert(bookings).values({ sessionId: session.id, personId: winner.id, status: "confirmed", paidWith: "free", source: "admin" });
    const [lb] = await h.db.insert(bookings).values({ sessionId: session.id, personId: loser.id, status: "confirmed", paidWith: "free", source: "admin" }).returning();
    expect(await merge(winner.id, loser.id)).toMatchObject({ ok: false, error: { code: "conflict", message: "both_booked_same_session", fields: { conflicts: "booking" } } });
    await h.db.update(bookings).set({ status: "cancelled", cancelledAt: new Date(), cancelReasonCode: "customer" }).where(eq(bookings.id, lb!.id));
    const preview = await queries.getMergePreview(h.db, winner.id, loser.id);
    expect(preview).toMatchObject({ conflicts: [], counts: { "bookings.person_id": 1 } });
    expect(preview.fields.map((f) => f.field)).toContain("email");
    expect(await merge(winner.id, loser.id)).toMatchObject({ ok: true });
    expect((await h.db.select().from(bookings).where(eq(bookings.id, lb!.id)))[0]!.personId).toBe(winner.id);
  });

  it("3.30 refuses a stale version, the same person, a merged or erased person, and a user without persons.merge", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    hooks.loserId = loser.id;
    expect(await actions.mergePersons({ winnerId: winner.id, loserId: loser.id, winnerVersion: winner.version + 1, loserVersion: loser.version, fieldChoices: {} })).toMatchObject({
      ok: false,
      error: { code: "conflict", message: "stale_version" },
    });
    expect(await merge(winner.id, winner.id)).toMatchObject({ ok: false, error: { code: "validation" } });
    const erased = await makePerson(h.db, { email: null, erasedAt: new Date() });
    expect(await merge(winner.id, erased.id)).toMatchObject({ ok: false, error: { code: "conflict", message: "person_erased" } });
    const merged = await makePerson(h.db, { mergedIntoPersonId: winner.id });
    expect(await merge(loser.id, merged.id)).toMatchObject({ ok: false, error: { code: "conflict", message: "person_already_merged" } });
    await signIn("reception");
    expect(await merge(winner.id, loser.id)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(spies.webinar).not.toHaveBeenCalled();
  });

  it("3.30 chain flattening: A into B, then B into C points A at C and the timeline resolves all three", async () => {
    const [pa, pb, pc] = [await makePerson(h.db), await makePerson(h.db), await makePerson(h.db)];
    expect((await merge(pb.id, pa.id)).ok).toBe(true);
    expect((await merge(pc.id, pb.id)).ok).toBe(true);
    expect((await person(pa.id)).mergedIntoPersonId).toBe(pc.id);
    expect((await person(pb.id)).mergedIntoPersonId).toBe(pc.id);
    expect((await resolvePersonIds(h.db, pc.id)).sort()).toEqual([pa.id, pb.id, pc.id].sort());
    expect((await resolvePersonIds(h.db, pa.id))[0]).toBe(pc.id);
  });

  it("3.33 consent: the latest record across both wins, so a newer loser withdrawal is copied and survives", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db);
    await consent(winner.id, "newsletter", "granted", day(1));
    const withdrawn = await consent(loser.id, "newsletter", "withdrawn", day(5));
    await consent(winner.id, "events", "withdrawn", day(9));
    await consent(loser.id, "events", "granted", day(4));
    expect((await merge(winner.id, loser.id)).ok).toBe(true);
    const copies = await h.db.select().from(consentRecords).where(and(eq(consentRecords.personId, winner.id), eq(consentRecords.copiedFromRecordId, withdrawn.id)));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ purpose: "newsletter", status: "withdrawn", method: "portal", source: "portal", wordingVersion: "newsletter@1" });
    expect(copies[0]!.recordedAt.toISOString()).toBe(day(5).toISOString());
    const winnerEvents = await h.db.select().from(consentRecords).where(and(eq(consentRecords.personId, winner.id), eq(consentRecords.purpose, "events")));
    expect(winnerEvents).toHaveLength(1);
    expect(await h.db.select().from(consentRecords).where(eq(consentRecords.personId, loser.id))).toHaveLength(2);
  });

  it("3.34 keeps the winner's override, else the loser's", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db, { statusOverride: "member", statusOverrideReason: "legacy member" });
    expect((await merge(winner.id, loser.id)).ok).toBe(true);
    expect(await person(winner.id)).toMatchObject({ statusOverride: "member", statusOverrideReason: "legacy member" });
  });
});

/**
 * crm-P4 sensitive fields (crm rules 3.23 to 3.26) on PGlite: only ciphertext is stored, both
 * actions need `persons.sensitive_read`, reveal goes through `readSensitive` with purpose
 * `staff_view` and a scope of exactly the requested keys or event ids, the audit rows carry keys
 * and never values, and no plaintext reaches `activity_events`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as PlatformApi from "@/modules/platform/api";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, auditLog, personSensitiveFields } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
process.env.AUTH_SECRET = "crm-p4-sensitive-secret";

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
      set: (name: string, value: string) => void jar.set(name, value),
      delete: (name: string) => void jar.delete(name),
    }),
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "192.0.2.42" })),
}));
vi.mock("next/server", () => ({ after: () => undefined }));
const spies = vi.hoisted(() => ({ readSensitive: undefined as unknown as Mock }));
vi.mock("@/modules/platform/api", async (importOriginal) => {
  const real = await importOriginal<typeof PlatformApi>();
  const { vi: v } = await import("vitest");
  spies.readSensitive = v.fn(real.readSensitive);
  return { ...real, readSensitive: spies.readSensitive };
});

const actions = await import("./actions");
const queries = await import("./queries");
const auth = await import("@/lib/auth");
const { and, eq, setAppDb } = await import("@/lib/ctx");
const { decryptSensitive, encryptNote, sensitiveAad } = await import("@/lib/sensitive");
const { makeCtx, resetRuntime, staffActor } = await import("@/lib/testing");

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
  spies.readSensitive.mockClear();
  owner = await signIn("owner");
});

async function signIn(roleKey: "owner" | "customer_service") {
  const user = await makeUser(h.db, { roleKey });
  const { token } = await auth.createAuthSession(h.db, { userId: user.id, audience: "staff", roleKey, now: new Date(), mfaAt: new Date() });
  jar.set(auth.SESSION_COOKIE, token);
  return user;
}

const secret = () => `slept badly, burn-out signs ${randomUUID().slice(0, 8)}`;
const fieldRow = async (personId: string, key: "sleep" | "medical" | "stress") =>
  (await h.db.select().from(personSensitiveFields).where(and(eq(personSensitiveFields.personId, personId), eq(personSensitiveFields.key, key))))[0];

describe("sensitive fields (rules 3.23 to 3.26)", () => {
  it("3.23 stores only ciphertext bound to the person and key", async () => {
    const p = await makePerson(h.db);
    const value = secret();
    expect(await actions.setSensitiveField({ personId: p.id, key: "sleep", value })).toEqual({ ok: true, data: {} });
    const row = await fieldRow(p.id, "sleep");
    expect(row).toBeDefined();
    expect(Buffer.from(row!.valueEnc).toString("utf8")).not.toContain(value);
    expect(Buffer.from(row!.valueEnc).toString("latin1")).not.toContain(value);
    expect(row!.updatedByUserId).toBe(owner.id);
    expect(decryptSensitive(row!.valueEnc, row!.keyVersion, sensitiveAad.personField(p.id, "sleep"))).toBe(value);
    expect(() => decryptSensitive(row!.valueEnc, row!.keyVersion, sensitiveAad.personField(p.id, "stress"))).toThrow();

    const updated = secret();
    await actions.setSensitiveField({ personId: p.id, key: "sleep", value: updated });
    const again = await fieldRow(p.id, "sleep");
    expect(again!.id).toBe(row!.id);
    expect(decryptSensitive(again!.valueEnc, again!.keyVersion, sensitiveAad.personField(p.id, "sleep"))).toBe(updated);
    expect((await queries.listSensitiveKeys(h.db, p.id)).map((k) => k.key)).toEqual(["sleep"]);

    await actions.setSensitiveField({ personId: p.id, key: "sleep", value: null });
    expect(await fieldRow(p.id, "sleep")).toBeUndefined();
    expect(await queries.listSensitiveKeys(h.db, p.id)).toEqual([]);
  });

  it("3.25 the write audit row and the timeline event carry the key only", async () => {
    const p = await makePerson(h.db);
    const value = secret();
    await actions.setSensitiveField({ personId: p.id, key: "medical", value });
    await actions.setSensitiveField({ personId: p.id, key: "medical", value: secret() });
    const audits = await h.db.select().from(auditLog).where(and(eq(auditLog.personId, p.id), eq(auditLog.action, "sensitive.write")));
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.newValue)).toEqual([
      { key: "medical", changed: true },
      { key: "medical", changed: true },
    ]);
    expect(audits.map((a) => a.oldValue)).toEqual(expect.arrayContaining([null, { key: "medical", changed: true }]));
    expect(JSON.stringify(await h.db.select().from(auditLog).where(eq(auditLog.personId, p.id)))).not.toContain(value);
    const events = await h.db.select().from(activityEvents).where(and(eq(activityEvents.personId, p.id), eq(activityEvents.kind, "sensitive.updated")));
    expect(events.map((e) => e.data)).toEqual([{ key: "medical" }, { key: "medical" }]);
  });

  it("3.24 reading and writing need persons.sensitive_read", async () => {
    const p = await makePerson(h.db);
    await actions.setSensitiveField({ personId: p.id, key: "stress", value: secret() });
    await signIn("customer_service");
    expect(await actions.setSensitiveField({ personId: p.id, key: "stress", value: "x" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await actions.revealSensitive({ personId: p.id, keys: ["stress"] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(spies.readSensitive).not.toHaveBeenCalled();
    const ctx = makeCtx(h.db, staffActor({ permissions: ["persons.read"] }));
    const { readSensitive } = await import("@/lib/sensitive");
    await expect(readSensitive(ctx, p.id, "staff_view", { keys: ["stress"] })).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("3.24 reveal calls readSensitive with staff_view and the requested keys and returns the bundle's fields", async () => {
    const p = await makePerson(h.db);
    const sleep = secret();
    await actions.setSensitiveField({ personId: p.id, key: "sleep", value: sleep });
    await actions.setSensitiveField({ personId: p.id, key: "stress", value: secret() });
    const res = await actions.revealSensitive({ personId: p.id, keys: ["sleep"] });
    expect(res).toEqual({ ok: true, data: { fields: { sleep }, notes: [] } });
    expect(spies.readSensitive).toHaveBeenCalledTimes(1);
    expect(spies.readSensitive.mock.calls[0]!.slice(1)).toEqual([p.id, "staff_view", { keys: ["sleep"] }]);

    const reads = await h.db.select().from(auditLog).where(and(eq(auditLog.personId, p.id), eq(auditLog.action, "sensitive.read")));
    expect(reads).toHaveLength(1);
    const audit = JSON.stringify([reads[0]!.oldValue, reads[0]!.newValue]);
    expect(audit).toContain("sleep");
    expect(audit).toContain("staff_view");
    expect(audit).not.toContain(sleep);
    expect(await h.db.select().from(auditLog).where(and(eq(auditLog.personId, p.id), eq(auditLog.action, "crm.reveal_sensitive")))).toHaveLength(0);
    expect(await actions.revealSensitive({ personId: p.id })).toMatchObject({ ok: false, error: { code: "validation" } });
  });

  it("3.26 revealing a sensitive note passes its event id and returns only that note", async () => {
    const p = await makePerson(h.db);
    const body = secret();
    const other = secret();
    const ctx = makeCtx(h.db, staffActor({ userId: owner.id, roleKey: "owner", permissions: ["*"] }));
    const first = await ctx.recordEvent({ kind: "note.added", personId: p.id, isSensitive: true, data: encryptNote(p.id, body) });
    await ctx.recordEvent({ kind: "note.added", personId: p.id, isSensitive: true, data: encryptNote(p.id, other) });
    const eventId = String(first.id);
    const res = await actions.revealSensitive({ personId: p.id, eventIds: [eventId] });
    expect(res).toEqual({ ok: true, data: { fields: {}, notes: [{ eventId, body }] } });
    expect(spies.readSensitive.mock.calls[0]!.slice(1)).toEqual([p.id, "staff_view", { eventIds: [eventId] }]);
    const reads = await h.db.select().from(auditLog).where(and(eq(auditLog.personId, p.id), eq(auditLog.action, "sensitive.read")));
    expect(JSON.stringify(reads)).toContain(eventId);
    expect(JSON.stringify(reads)).not.toContain(body);
  });

  it("3.26 and 3.32 a merged loser's sensitive note is revealed on the winner, read and audited for its owner (fix-w09-crm-review)", async () => {
    const winner = await makePerson(h.db);
    const loser = await makePerson(h.db, { mergedIntoPersonId: winner.id });
    const stranger = await makePerson(h.db);
    const [loserBody, winnerBody, strangerBody] = [secret(), secret(), secret()];
    const ctx = makeCtx(h.db, staffActor({ userId: owner.id, roleKey: "owner", permissions: ["*"] }));
    const loserNote = String((await ctx.recordEvent({ kind: "note.added", personId: loser.id, isSensitive: true, data: encryptNote(loser.id, loserBody) })).id);
    const winnerNote = String((await ctx.recordEvent({ kind: "note.added", personId: winner.id, isSensitive: true, data: encryptNote(winner.id, winnerBody) })).id);
    const strangerNote = String((await ctx.recordEvent({ kind: "note.added", personId: stranger.id, isSensitive: true, data: encryptNote(stranger.id, strangerBody) })).id);

    const res = await actions.revealSensitive({ personId: winner.id, eventIds: [loserNote, winnerNote, strangerNote] });
    expect(res.ok).toBe(true);
    const notes = (res as { data: { notes: { eventId: string; body: string }[] } }).data.notes;
    expect(notes).toHaveLength(2);
    expect(notes).toEqual(expect.arrayContaining([{ eventId: loserNote, body: loserBody }, { eventId: winnerNote, body: winnerBody }]));
    expect(JSON.stringify(notes)).not.toContain(strangerBody);
    expect(spies.readSensitive.mock.calls.map((c) => c.slice(1))).toEqual([
      [winner.id, "staff_view", { eventIds: [winnerNote] }],
      [loser.id, "staff_view", { eventIds: [loserNote] }],
    ]);
    const loserReads = await h.db.select().from(auditLog).where(and(eq(auditLog.personId, loser.id), eq(auditLog.action, "sensitive.read")));
    expect(JSON.stringify(loserReads)).toContain(loserNote);
    expect(JSON.stringify(loserReads)).not.toContain(loserBody);

    // only a loser's note: one read, for the loser
    spies.readSensitive.mockClear();
    expect(await actions.revealSensitive({ personId: winner.id, eventIds: [loserNote] })).toEqual({ ok: true, data: { fields: {}, notes: [{ eventId: loserNote, body: loserBody }] } });
    expect(spies.readSensitive.mock.calls.map((c) => c.slice(1))).toEqual([[loser.id, "staff_view", { eventIds: [loserNote] }]]);
  });

  it("3.23 no plaintext in activity_events, and merged or unknown persons are refused", async () => {
    const p = await makePerson(h.db);
    const values = [secret(), secret()];
    await actions.setSensitiveField({ personId: p.id, key: "sleep", value: values[0]! });
    await actions.setSensitiveField({ personId: p.id, key: "medical", value: values[1]! });
    const rows = await h.db.select({ kind: activityEvents.kind, data: activityEvents.data }).from(activityEvents).where(eq(activityEvents.personId, p.id));
    expect(rows.map((r) => r.kind)).toEqual(["sensitive.updated", "sensitive.updated"]);
    const dump = JSON.stringify(rows);
    for (const v of values) expect(dump).not.toContain(v);

    const winner = await makePerson(h.db);
    const merged = await makePerson(h.db, { mergedIntoPersonId: winner.id });
    expect(await actions.setSensitiveField({ personId: merged.id, key: "sleep", value: "x" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await actions.setSensitiveField({ personId: randomUUID(), key: "sleep", value: "x" })).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents } from "@beam/db/schema";
import { PermanentError } from "@beam/core/errors";
import { eq } from "./ctx";
import { makeCtx, resetRuntime } from "./testing";
import { encryptNote } from "./sensitive";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
  process.env.SENSITIVE_DATA_KEY_V1 ??= Buffer.alloc(32, 7).toString("base64");
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

describe("recordEvent", () => {
  it("validates data with the event's Zod schema", async () => {
    const ctx = makeCtx(handle.db);
    const person = await makePerson(handle.db);
    await expect(ctx.recordEvent({ kind: "platform.signed_in", personId: person.id, data: { method: "carrier pigeon" } })).rejects.toBeInstanceOf(PermanentError);
    const ok = await ctx.recordEvent({ kind: "platform.signed_in", personId: person.id, data: { method: "password" } });
    expect(typeof ok.id).toBe("bigint");
    const [row] = await handle.db.select().from(activityEvents).where(eq(activityEvents.id, ok.id!));
    expect(row).toMatchObject({ kind: "platform.signed_in", personId: person.id, data: { method: "password" }, isSensitive: false });
    expect(row!.actor).toEqual({ kind: "system", id: null });
  });

  it("returns a null id for a duplicate dedupe key", async () => {
    const ctx = makeCtx(handle.db);
    const person = await makePerson(handle.db);
    const input = { kind: "platform.signed_in" as const, personId: person.id, data: { method: "magic_link" }, dedupeKey: `signin:${person.id}:2026-11-03` };
    const first = await ctx.recordEvent(input);
    const second = await ctx.recordEvent(input);
    expect(first.id).not.toBeNull();
    expect(second.id).toBeNull();
    expect(await handle.db.select().from(activityEvents).where(eq(activityEvents.personId, person.id))).toHaveLength(1);
  });

  it("requires the subject of the definition (person events need a personId)", async () => {
    const ctx = makeCtx(handle.db);
    await expect(ctx.recordEvent({ kind: "platform.password_set", data: {} })).rejects.toThrow(/event_subject_required/);
    await expect(ctx.recordEvent({ kind: "platform.password_set", companyId: crypto.randomUUID(), data: {} })).rejects.toThrow(/needs personId/);
  });

  it("refuses an unknown kind", async () => {
    const ctx = makeCtx(handle.db);
    await expect(ctx.recordEvent({ kind: "platform.nonexistent" as never, personId: crypto.randomUUID(), data: {} })).rejects.toThrow(/unknown_event_kind/);
  });

  it("a sensitive event stores only the encrypted body", async () => {
    const ctx = makeCtx(handle.db);
    const person = await makePerson(handle.db);
    await expect(ctx.recordEvent({ kind: "platform.password_set", personId: person.id, data: { body: "plain" }, isSensitive: true })).rejects.toThrow(/not_encrypted/);
    const { id } = await ctx.recordEvent({ kind: "platform.password_set", personId: person.id, data: encryptNote(person.id, "knee"), isSensitive: true });
    const [row] = await handle.db.select().from(activityEvents).where(eq(activityEvents.id, id!));
    expect(Object.keys(row!.data as object).sort()).toEqual(["body_enc", "key_version"]);
    expect(JSON.stringify(row!.data)).not.toContain("knee");
  });
});

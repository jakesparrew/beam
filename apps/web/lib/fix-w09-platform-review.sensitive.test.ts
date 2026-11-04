// Review fixes of fix-w09-platform-review for lib/sensitive.ts: notes sort by the numeric event
// id, not its text alias (request of crm-P7).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents } from "@beam/db/schema";
import { encryptNote, readSensitive, setCurrentKeyVersion } from "./sensitive";
import { makeCtx, resetRuntime } from "./testing";

let handle: DbHandle;
beforeAll(async () => {
  process.env.SENSITIVE_DATA_KEY_V1 = Buffer.alloc(32, 1).toString("base64");
  setCurrentKeyVersion(1);
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

describe("readSensitive note order", () => {
  it("returns notes with the same occurred_at in numeric id order (9 before 10)", async () => {
    const person = await makePerson(handle.db);
    const at = new Date("2026-11-03T10:00:00Z");
    const actor = { kind: "system" as const, id: null };
    // Ids 1..8 are plain events, so the two notes get ids 9 and 10 (text order would be "10", "9").
    for (let i = 0; i < 8; i++) {
      await handle.db.insert(activityEvents).values({ personId: person.id, kind: "platform.filler", occurredAt: at, actor, data: {} });
    }
    const ids: bigint[] = [];
    for (const body of ["first note", "second note"]) {
      const [row] = await handle.db
        .insert(activityEvents)
        .values({ personId: person.id, kind: "crm.note_added", occurredAt: at, actor, isSensitive: true, data: encryptNote(person.id, body, 1) })
        .returning({ id: activityEvents.id });
      ids.push(row!.id);
    }
    expect(ids.map(String)).toEqual(["9", "10"]);
    const ctx = makeCtx(handle.db, { kind: "system", jobId: crypto.randomUUID() });
    const bundle = await readSensitive(ctx, person.id, "privacy_export");
    expect(bundle.notes).toEqual([
      { eventId: "9", body: "first note" },
      { eventId: "10", body: "second note" },
    ]);
  });
});

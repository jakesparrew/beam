import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makePerson } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog } from "@beam/db/schema";
import { auditDigest, REDACTED, redactForAudit } from "./audit";
import { eq } from "./ctx";
import { makeCtx, resetRuntime, staffActor } from "./testing";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

describe("redactForAudit (PL-21)", () => {
  it("redacts secrets, sensitive field keys and *_enc columns, recursively", () => {
    const value = {
      name: "Ann",
      password: "hunter2",
      passwordHash: "$argon2id$x",
      access_token: "t",
      totp_secret_enc: new Uint8Array([1]),
      recoveryCodes: ["a"],
      clientSecret: "s",
      health_note: "knee",
      sleep: 4,
      nested: { stress: "high", value_enc: "x", keep: 1, list: [{ medical: "m", ok: true }] },
      locale: "nl-BE",
    };
    expect(redactForAudit(value)).toEqual({
      name: "Ann",
      password: REDACTED,
      passwordHash: REDACTED,
      access_token: REDACTED,
      totp_secret_enc: REDACTED,
      recoveryCodes: REDACTED,
      clientSecret: REDACTED,
      health_note: REDACTED,
      sleep: REDACTED,
      nested: { stress: REDACTED, value_enc: REDACTED, keep: 1, list: [{ medical: REDACTED, ok: true }] },
      locale: "nl-BE",
    });
  });

  it("keeps scalars, nulls and dates (as ISO strings)", () => {
    expect(redactForAudit(null)).toBeNull();
    expect(redactForAudit(3)).toBe(3);
    expect(redactForAudit({ at: new Date("2026-11-03T10:00:00Z") })).toEqual({ at: "2026-11-03T10:00:00.000Z" });
  });

  it("ctx.audit writes one row with redacted values, actor, request id and ip", async () => {
    const actor = staffActor({ roleKey: "owner", permissions: ["*"] });
    const ctx = makeCtx(handle.db, { actor, requestId: "req_1", ip: "203.0.113.9" });
    const person = await makePerson(handle.db);
    await ctx.audit({ action: "users.update", entityType: "user", entityId: "u1", personId: person.id, oldValue: { password: "a", role: "sales" }, newValue: { password: "b", role: "finance" } });
    const [row] = await handle.db.select().from(auditLog).where(eq(auditLog.requestId, "req_1"));
    expect(row).toMatchObject({
      action: "users.update",
      entityType: "user",
      entityId: "u1",
      personId: person.id,
      oldValue: { password: REDACTED, role: "sales" },
      newValue: { password: REDACTED, role: "finance" },
      ip: "203.0.113.9",
      actor: { kind: "staff", id: actor.userId, roleKey: "owner" },
    });
  });

  it("auditDigest is a stable sha256 of the JSON", () => {
    expect(auditDigest({ a: 1 })).toEqual(auditDigest({ a: 1 }));
    expect(auditDigest({ a: 1 }).digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

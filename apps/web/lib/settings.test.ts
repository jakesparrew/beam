import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { auditLog, settings } from "@beam/db/schema";
import { ConflictError, eq, sql, ValidationError } from "./ctx";
import { getSetting, getSettingWithVersion, setSetting, writeSystemSetting } from "./settings";
import { makeCtx, resetRuntime, staffActor } from "./testing";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`delete from settings`);
  await handle.db.execute(sql`set beam.allow_rewrite = 'on'`);
  await handle.db.execute(sql`delete from audit_log`);
  await handle.db.execute(sql`reset beam.allow_rewrite`);
});

let ownerId: string;
beforeAll(async () => {
  ownerId = (await makeUser(handle.db, { roleKey: "owner" })).id;
});
const owner = () => makeCtx(handle.db, { actor: staffActor({ userId: ownerId, roleKey: "owner", permissions: ["*"] }) });

describe("getSetting (PL-42)", () => {
  it("returns the declared default when no row exists", async () => {
    const ai = await getSetting(handle.db, "ai");
    expect(ai.monthly_budget_cents).toBe(10_000);
    expect(ai.sensitive_enabled).toBe(false);
    expect(await getSetting(handle.db, "last_tick_at")).toBeNull();
    expect((await getSettingWithVersion(handle.db, "security")).version).toBe(0);
  });

  it("returns the stored value when it matches the schema", async () => {
    const ctx = owner();
    const current = await getSetting(handle.db, "ai");
    await setSetting(ctx, "ai", { ...current, monthly_budget_cents: 5000 }, 0);
    expect((await getSetting(handle.db, "ai")).monthly_budget_cents).toBe(5000);
  });
});

describe("setSetting (PL-41)", () => {
  it("bumps the version and audits old and new value", async () => {
    const ctx = owner();
    const value = await getSetting(handle.db, "support");
    expect(await setSetting(ctx, "support", { ...value, emergency_phone: "+32 2 000 00 00" }, 0)).toEqual({ version: 1 });
    expect(await setSetting(ctx, "support", { ...value, emergency_phone: "+32 2 111 11 11" }, 1)).toEqual({ version: 2 });
    const rows = await handle.db.select().from(auditLog).where(eq(auditLog.action, "settings.update"));
    expect(rows).toHaveLength(2);
    const second = rows.find((r) => (r.newValue as { emergency_phone: string }).emergency_phone === "+32 2 111 11 11")!;
    expect(second).toMatchObject({ entityType: "settings", entityId: "support" });
    expect((second.oldValue as { emergency_phone: string }).emergency_phone).toBe("+32 2 000 00 00");
    const [row] = await handle.db.select().from(settings).where(eq(settings.key, "support"));
    expect(row!.updatedByUserId).toBe((ctx.actor as { userId: string }).userId);
  });

  it("a stale version is a conflict and writes nothing", async () => {
    const ctx = owner();
    const value = await getSetting(handle.db, "company");
    await setSetting(ctx, "company", { ...value, phone: "1" }, 0);
    await expect(setSetting(ctx, "company", { ...value, phone: "2" }, 0)).rejects.toBeInstanceOf(ConflictError);
    expect((await getSetting(handle.db, "company")).phone).toBe("1");
    expect(await handle.db.select().from(auditLog)).toHaveLength(1);
  });

  it("a value that fails the schema is a validation error", async () => {
    const ctx = owner();
    const value = await getSetting(handle.db, "company");
    await expect(setSetting(ctx, "company", { ...value, vat_number: "NL123" }, 0)).rejects.toBeInstanceOf(ValidationError);
  });

  it("system keys skip the version bump and the audit row", async () => {
    const at = new Date().toISOString();
    await writeSystemSetting(handle.db, "last_tick_at", at);
    await writeSystemSetting(handle.db, "last_tick_at", at);
    expect(await getSetting(handle.db, "last_tick_at")).toBe(at);
    const [row] = await handle.db.select().from(settings).where(eq(settings.key, "last_tick_at"));
    expect(row!.version).toBe(1);
    await setSetting(owner(), "last_tick_at", at, 99);
    expect(await handle.db.select().from(auditLog)).toHaveLength(0);
  });
});

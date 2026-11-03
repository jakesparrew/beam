import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { featureFlags } from "@beam/db/schema";

vi.mock("@/registry/flags.generated", () => ({
  FLAGS: { ff_platform_example: { key: "ff_platform_example", description: "test flag", owner: "platform" } },
}));

import { eq, setAppDb, sql } from "./ctx";
import { clearFlagCache, flag, FLAG_CACHE_MS } from "./flags";
import { resetRuntime, staffActor } from "./testing";

const KEY = "ff_platform_example" as never;
let handle: DbHandle;

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  clearFlagCache();
  await handle.db.execute(sql`delete from feature_flags`);
});
afterEach(() => vi.useRealTimers());

const setFlag = (values: Partial<typeof featureFlags.$inferInsert>) =>
  handle.db
    .insert(featureFlags)
    .values({ key: "ff_platform_example", ...values })
    .onConflictDoUpdate({ target: featureFlags.key, set: values });

describe("flag (PL-43)", () => {
  it("a declared flag without a row is off; an undeclared key is always off", async () => {
    const user = await makeUser(handle.db, { isTester: true });
    expect(await flag(KEY, staffActor({ userId: user.id }))).toBe(false);
    await handle.db.insert(featureFlags).values({ key: "ff_platform_orphan", state: "on" });
    expect(await flag("ff_platform_orphan" as never, staffActor({ userId: user.id }))).toBe(false);
  });

  it("off, testers and on with user and person testers", async () => {
    const tester = await makeUser(handle.db, { isTester: true });
    const regular = await makeUser(handle.db, { isTester: false });
    const listed = await makeUser(handle.db, { isTester: false });
    const testerPerson = await makePerson(handle.db, { isTester: true });
    const customerUser = await makeUser(handle.db, { audience: "customer", personId: testerPerson.id, isTester: false });
    const plainPerson = await makePerson(handle.db, { isTester: false });
    const plainCustomer = await makeUser(handle.db, { audience: "customer", personId: plainPerson.id, isTester: false });
    const listedPerson = await makePerson(handle.db, { isTester: false });
    const listedCustomer = await makeUser(handle.db, { audience: "customer", personId: listedPerson.id, isTester: false });

    const staff = (id: string) => staffActor({ userId: id });
    const customer = (userId: string, personId: string) => ({ kind: "customer" as const, userId, personId });

    await setFlag({ state: "off" });
    clearFlagCache();
    expect(await flag(KEY, staff(tester.id))).toBe(false);

    await setFlag({ state: "testers", userIds: [listed.id], personIds: [listedPerson.id] });
    clearFlagCache();
    expect(await flag(KEY, staff(tester.id))).toBe(true);
    expect(await flag(KEY, staff(regular.id))).toBe(false);
    expect(await flag(KEY, staff(listed.id))).toBe(true);
    expect(await flag(KEY, customer(customerUser.id, testerPerson.id))).toBe(true);
    expect(await flag(KEY, customer(plainCustomer.id, plainPerson.id))).toBe(false);
    expect(await flag(KEY, customer(listedCustomer.id, listedPerson.id))).toBe(true);
    expect(await flag(KEY, { kind: "public" })).toBe(false);

    await setFlag({ state: "on" });
    clearFlagCache();
    expect(await flag(KEY, staff(regular.id))).toBe(true);
    expect(await flag(KEY, { kind: "public" })).toBe(true);
  });

  it("caches the resolved row for 60 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const user = await makeUser(handle.db);
    await setFlag({ state: "on" });
    expect(await flag(KEY, staffActor({ userId: user.id }))).toBe(true);
    await handle.db.update(featureFlags).set({ state: "off" }).where(eq(featureFlags.key, "ff_platform_example"));
    vi.advanceTimersByTime(FLAG_CACHE_MS - 1000);
    expect(await flag(KEY, staffActor({ userId: user.id }))).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(await flag(KEY, staffActor({ userId: user.id }))).toBe(false);
  });
});

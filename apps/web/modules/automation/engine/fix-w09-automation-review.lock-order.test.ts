/**
 * Lock order (fix-w09-automation-review, finding 5): the step job, the dead-step hook and the
 * version migration lock the enrolment's person before the enrolment row, the evaluator's
 * order (enrol() locks the person, then the domain holder enrolment). The opposite order
 * deadlocks a step job that reaches crm (tag, untag, set_field, status_override, enrol) with an
 * evaluator batch that supersedes or exits the same enrolment.
 *
 * PGlite has one connection, so the test records the SQL text of every statement in order and
 * checks that the person `FOR UPDATE` comes before the enrolment `FOR UPDATE`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DbHandle, Tx } from "@beam/db";
import { automations, automationVersions } from "@beam/db/schema";
import { createTestDb, makePerson } from "@beam/db/testing";
import { eq } from "@/lib/ctx";
import { makeCtx, resetRuntime } from "@/lib/testing";
import type * as EmailApi from "@/modules/email/api";

vi.mock("@/modules/email/api", async (orig) => ({
  ...(await orig<typeof EmailApi>()),
  getReachability: vi.fn(() => Promise.resolve({ isReachable: true, blockedReason: null })),
}));

const { runStep } = await import("./step");
const { lockEnrolmentPerson, recordDeadStep } = await import("./advance");
const { migrateEnrolments } = await import("./bulk");
const f = await import("./automation-p3.fixtures");

type Queryable = { query: (text: string, ...rest: unknown[]) => Promise<unknown> };
type Client = Queryable & { transaction: <T>(fn: (t: Queryable) => Promise<T>) => Promise<T> };

let h: DbHandle;
let client: Client;
let log: string[] = [];
const origQuery: Client["query"] = (...a) => Reflect.apply(Object.getPrototypeOf(client).query as Client["query"], client, a);
const origTransaction: Client["transaction"] = (fn) => Reflect.apply(Object.getPrototypeOf(client).transaction as Client["transaction"], client, [fn]);

beforeAll(async () => {
  h = await createTestDb();
  await f.makeTag(h.db, "engaged");
  client = (h.db as unknown as { $client: Client }).$client;
  // Record every statement, on the client and inside its transactions.
  client.query = (text, ...rest) => {
    log.push(text);
    return origQuery(text, ...rest);
  };
  client.transaction = (fn) =>
    origTransaction((t) => {
      const q = t.query.bind(t);
      t.query = (text, ...rest) => {
        log.push(text);
        return q(text, ...rest);
      };
      return fn(t);
    });
});
afterEach(() => {
  log = [];
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const now = new Date("2026-11-06T09:00:00Z");
const tx = () => h.db as unknown as Tx;
const tag = (key: string, minutes = 0) => ({ key, type: "tag" as const, tag: "engaged", at: { from: "enrolment" as const, minutes } });

/** Index of the first person lock and of the first enrolment lock in the statement log. */
function lockOrder(): { person: number; enrolment: number } {
  const isLock = (s: string) => /for update/i.test(s);
  const person = log.findIndex((s) => isLock(s) && /for update of "?p"?\b/i.test(s) && /from "?persons"?/i.test(s));
  const enrolment = log.findIndex((s) => isLock(s) && /from "automation_enrolments"/i.test(s) && !/from "?persons"?/i.test(s));
  return { person, enrolment };
}

async function enrolled(list = [tag("s1"), tag("s2", 60)]) {
  const a = await f.makeAutomation(h.db, { isMarketing: false, definition: f.steps(list) });
  const p = await makePerson(h.db);
  const id = await f.enrolInto(h.db, a.id, p.id, { now });
  return { a, p, id };
}

describe("lock order: person, then enrolment", () => {
  it("lockEnrolmentPerson locks the person of an existing enrolment and is false for a missing one", async () => {
    const { id } = await enrolled();
    expect(await lockEnrolmentPerson(tx(), id)).toBe(true);
    expect(await lockEnrolmentPerson(tx(), "00000000-0000-4000-8000-00000000dead")).toBe(false);
  });

  it("runStep locks the person before the enrolment; a tag step then reaches crm under that lock", async () => {
    const { id } = await enrolled();
    log = [];
    expect(await runStep(tx(), { enrolmentId: id, stepKey: "s1", now }, { ctx: makeCtx(h.db, { now }) })).toMatchObject({ status: "ran", nextStepKey: "s2" });
    const { person, enrolment } = lockOrder();
    expect(person).toBeGreaterThanOrEqual(0);
    expect(enrolment).toBeGreaterThan(person);
  });

  it("runStep of a missing enrolment is a no-op", async () => {
    expect(await runStep(tx(), { enrolmentId: "00000000-0000-4000-8000-00000000dead", stepKey: "s1", now }, { ctx: makeCtx(h.db, { now }) })).toEqual({
      status: "noop",
      reason: "missing",
    });
  });

  it("recordDeadStep locks the person before the enrolment", async () => {
    const { id } = await enrolled();
    log = [];
    expect(await recordDeadStep({ tx: tx(), actor: f.SYSTEM, now }, { enrolmentId: id, stepKey: "s1" }, { message: "boom", permanent: true })).toEqual({
      written: true,
      advanced: true,
    });
    const { person, enrolment } = lockOrder();
    expect(person).toBeGreaterThanOrEqual(0);
    expect(enrolment).toBeGreaterThan(person);
  });

  it("migrateEnrolments locks the person before the enrolment inside each savepoint", async () => {
    const { a, id } = await enrolled();
    const [v2] = await h.db
      .insert(automationVersions)
      .values({ automationId: a.id, version: 2, definition: f.steps([tag("s1"), tag("s3", 120)]), definitionHash: randomUUID() })
      .returning();
    await h.db.update(automations).set({ currentVersionId: v2!.id }).where(eq(automations.id, a.id));
    log = [];
    expect(await migrateEnrolments(tx(), makeCtx(h.db, { now }), { automationId: a.id, toVersionId: v2!.id })).toMatchObject({ handled: 1, migrated: 1 });
    const { person, enrolment } = lockOrder();
    expect(person).toBeGreaterThanOrEqual(0);
    expect(enrolment).toBeGreaterThan(person);
    expect(await f.enrolmentRow(h.db, id)).toMatchObject({ status: "exited", endReason: "migrated" });
  });
});

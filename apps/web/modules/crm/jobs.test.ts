/**
 * crm-P7 jobs (conventions: every job runs twice in `jobs.test.ts`): each crm job kind, run twice
 * with the same payload through `runJobTwice`, leaves the database exactly as after the first run.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { personTags, tags } from "@beam/db/schema";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
vi.mock("next/server", () => ({ after: () => undefined }));

const { jobs } = await import("./jobs");
const fixtures = await import("./segments/test-fixtures");
const { setAppDb, sql } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");
const { resetRuntime, runJobTwice } = await import("@/lib/testing");

let h: DbHandle;
let staffId: string;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await fixtures.ensurePersonProfileView(h.db);
  staffId = (await makeUser(h.db, { roleKey: "owner" })).id;
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** Everything a crm job may write, in a stable order (timestamps excluded). */
async function snapshot(): Promise<unknown> {
  const q = async (s: ReturnType<typeof sql>) => rowsOf(await h.db.execute(s));
  return {
    candidates: await q(sql`select person_a_id, person_b_id, score, reasons, status from person_duplicate_candidates order by person_a_id, person_b_id`),
    jobs: await q(sql`select kind, idempotency_key, payload from jobs order by kind, idempotency_key`),
    members: await q(sql`select segment_id, person_id, source from segment_members order by segment_id, person_id`),
    segments: await q(sql`select id, last_count, refresh_error from segments order by id`),
    events: await q(sql`select kind, person_id, dedupe_key from activity_events order by kind, person_id, dedupe_key`),
  };
}

async function twiceSameState(kind: string, payload: unknown) {
  let afterFirst: unknown;
  await runJobTwice(h.db, kind as never, payload, {
    between: async () => {
      afterFirst = await snapshot();
    },
  });
  expect(await snapshot()).toEqual(afterFirst);
}

const PAYLOADS: Record<string, () => Promise<unknown>> = {
  "crm.check_duplicates": async () => {
    const digits = String(Math.floor(Math.random() * 900000) + 100000);
    const a = await makePerson(h.db, { phone: `0470 ${digits}`, phoneE164: `+32470${digits}` });
    await makePerson(h.db, { phone: `+32 470 ${digits}`, phoneE164: `+32470${digits}` });
    return { personId: a.id };
  },
  "crm.detect_duplicates": async () => {
    const lastName = `Maes ${randomUUID().slice(0, 6)}`;
    await makePerson(h.db, { firstName: "Lies", lastName, birthOn: "1991-04-04" });
    await makePerson(h.db, { firstName: "Lies", lastName, birthOn: "1991-04-04" });
    return {};
  },
  "segments.refresh": async () => {
    await fixtures.insertSegment(h.db, { definition: fixtures.tagRule(`k-${randomUUID().slice(0, 6)}`) });
    return {};
  },
  "segments.refresh_one": async () => {
    const key = `seg-${randomUUID().slice(0, 6)}`;
    const [tag] = await h.db.insert(tags).values({ key, name: { en: key, "nl-BE": key, "fr-BE": key } }).returning();
    for (let i = 0; i < 3; i++) {
      const p = await makePerson(h.db);
      await h.db.insert(personTags).values({ personId: p.id, tagId: tag!.id, source: "manual", addedBy: { kind: "staff", id: staffId } });
    }
    const segmentId = await fixtures.insertSegment(h.db, { definition: fixtures.tagRule(key) });
    return { segmentId, reason: "schedule" };
  },
};

describe("crm jobs run twice yield the same state", () => {
  // Only the kinds this file has payloads for: the R3 kinds (pipeline, inbox) run twice in their
  // own `pipeline/jobs.test.ts` and `inbox/jobs.test.ts` (CONVENTIONS item 11).
  const OWN = jobs.filter((j) => j.kind in PAYLOADS);

  it("every payload names a registered crm job", () => {
    for (const k of Object.keys(PAYLOADS)) expect(jobs.some((j) => j.kind === k), k).toBe(true);
  });

  it.each(OWN.map((j) => j.kind))("%s", async (kind) => {
    const payload = await PAYLOADS[kind]!();
    await twiceSameState(kind, payload);
  });

  it("crm.check_duplicates finds the pair once", async () => {
    const payload = (await PAYLOADS["crm.check_duplicates"]!()) as { personId: string };
    await runJobTwice(h.db, "crm.check_duplicates", payload);
    const rows = rowsOf<{ n: number }>(await h.db.execute(sql`select count(*)::int as n from person_duplicate_candidates where person_a_id = ${payload.personId} or person_b_id = ${payload.personId}`));
    expect(Number(rows[0]!.n)).toBe(1);
  });
});

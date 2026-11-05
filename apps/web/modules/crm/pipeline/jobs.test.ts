/**
 * crm-P8 jobs (conventions: every job runs twice): `crm.escalate_opportunities` and
 * `crm.apply_btoc_playbook`, each run twice with the same payload through `runJobTwice`,
 * leave the database exactly as after the first run (tasks, jobs, events, guards).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { activityEvents, companies, opportunities, playbookStages } from "@beam/db/schema";
import { defaultPlaybookRows } from "@beam/db/seed/crm";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
vi.mock("next/server", () => ({ after: () => undefined }));
vi.mock("@/modules/automation/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  enrolPersonBySlug: vi.fn(async () => ({ status: "enrolled", enrolmentId: "00000000-0000-4000-8000-000000000002" })),
}));

const { jobs } = await import("../jobs");
const { setAppDb, sql } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");
const { resetRuntime, runJobTwice } = await import("@/lib/testing");

let h: DbHandle;
let salesId: string;
const DAY = 86_400_000;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  await h.db.insert(playbookStages).values(defaultPlaybookRows()).onConflictDoNothing();
  salesId = (await makeUser(h.db, { roleKey: "sales" })).id;
  await makeUser(h.db, { roleKey: "management" });
  await makeUser(h.db, { roleKey: "customer_service" });
  await makeUser(h.db, { roleKey: "owner" });
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

/** Everything the pipeline jobs may write, in a stable order (timestamps excluded). */
async function snapshot(): Promise<unknown> {
  const q = async (s: ReturnType<typeof sql>) => rowsOf(await h.db.execute(s));
  return {
    tasks: await q(sql`select dedupe_key, owner_user_id, person_id, company_id, opportunity_id, status, priority from tasks order by dedupe_key`),
    jobs: await q(sql`select kind, idempotency_key, payload from jobs order by kind, idempotency_key`),
    events: await q(sql`select kind, person_id, company_id, dedupe_key from activity_events order by kind, person_id, company_id, dedupe_key`),
    guards: await q(sql`select key from rate_limits order by key`),
  };
}

const PAYLOADS: Record<string, () => Promise<unknown>> = {
  "crm.escalate_opportunities": async () => {
    const [c] = await h.db.insert(companies).values({ name: `Stalled ${randomUUID().slice(0, 6)}` }).returning();
    await h.db.insert(opportunities).values({ companyId: c!.id, title: "Stalled deal", ownerUserId: salesId, stage: "negotiation", stageEnteredAt: new Date(Date.now() - 30 * DAY) });
    return {};
  },
  "crm.apply_btoc_playbook": async () => {
    const p = await makePerson(h.db);
    await h.db.insert(activityEvents).values({ personId: p.id, kind: "ops.stage_changed", actor: { kind: "system", id: null }, data: { from: "lead", to: "engaged_lead" }, dedupeKey: `stage:${p.id}:engaged_lead:${randomUUID()}` });
    return {};
  },
};

describe("crm pipeline jobs run twice yield the same state", () => {
  it("every pipeline kind is registered", () => {
    for (const k of Object.keys(PAYLOADS)) expect(jobs.some((j) => j.kind === k), k).toBe(true);
  });

  it.each(Object.keys(PAYLOADS))("%s", async (kind) => {
    const payload = await PAYLOADS[kind]!();
    let afterFirst: unknown;
    const { first } = await runJobTwice(h.db, kind as never, payload, {
      between: async () => {
        afterFirst = await snapshot();
      },
    });
    expect(first).toMatchObject(kind === "crm.escalate_opportunities" ? { escalated: 1 } : { created: 1 });
    expect(await snapshot()).toEqual(afterFirst);
  });
});

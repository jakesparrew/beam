/**
 * crm-P9 jobs (conventions: every job runs twice): `crm.send_meta_reply`,
 * `crm.close_stale_threads`, `crm.escalate_threads` and the `meta` webhook handler, each run
 * twice with the same input in its own transaction, leave the database exactly as after the
 * first run (threads, messages, tasks, jobs, events) and call the provider once.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, makePerson, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { inboxMessages, inboxThreads, settings } from "@beam/db/schema";
import { createMetaMessagingFake } from "@beam/integrations/meta-messaging";

process.env.SENSITIVE_DATA_KEY_V1 ??= randomBytes(32).toString("base64");
vi.mock("next/server", () => ({ after: () => undefined }));
// The inbox kinds are declared in crm's `jobs.ts` facade; until they are, the test registry
// carries the real definitions from `./jobs` (a registered definition wins).
vi.mock("@/registry/jobs.generated", async (importOriginal) => {
  const mod = await importOriginal<{ JOB_BY_KIND: Record<string, unknown> }>();
  const { INBOX_JOBS } = await import("./jobs");
  const added: Record<string, unknown> = {};
  for (const def of INBOX_JOBS) if (!mod.JOB_BY_KIND[def.kind]) added[def.kind] = def;
  return { ...mod, JOB_BY_KIND: { ...mod.JOB_BY_KIND, ...added } };
});

const { handleMetaWebhook, INBOX_JOBS, setMetaMessagingClient } = await import("./jobs");
const { flushDurableWrites, setAppDb, sql } = await import("@/lib/ctx");
const { rowsOf } = await import("@/lib/sensitive");
const { makeJobCtx, resetRuntime, runJobTwice } = await import("@/lib/testing");

let h: DbHandle;
const fake = createMetaMessagingFake();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeAll(async () => {
  h = await createTestDb();
  setAppDb(h.db);
  setMetaMessagingClient(fake);
  await makeUser(h.db, { roleKey: "customer_service" });
  await makeUser(h.db, { roleKey: "owner" });
  await h.db
    .insert(settings)
    .values({ key: "inbox", value: { escalation_hours: 24, stale_pending_days: 14, default_assignee_role: "customer_service", meta_enabled: true } })
    .onConflictDoNothing();
});
afterAll(async () => {
  setMetaMessagingClient(undefined);
  resetRuntime();
  await h.close();
});

/** Everything the inbox jobs may write, in a stable order (timestamps excluded). */
async function snapshot(): Promise<unknown> {
  const q = async (s: ReturnType<typeof sql>) => rowsOf(await h.db.execute(s));
  return {
    threads: await q(sql`select id, status, person_id, escalated_at is not null as escalated, resolved_at is not null as resolved from inbox_threads order by id`),
    messages: await q(sql`select id, thread_id, direction, external_message_id, delivery_error from inbox_messages order by id`),
    tasks: await q(sql`select dedupe_key, owner_user_id, person_id, status, priority from tasks order by dedupe_key`),
    jobs: await q(sql`select kind, idempotency_key from jobs order by kind, idempotency_key`),
    events: await q(sql`select kind, person_id, dedupe_key from activity_events order by kind, person_id, dedupe_key`),
  };
}

async function metaThread(lastInboundAgoMs: number) {
  const now = Date.now();
  const psid = `psid-${randomUUID()}`;
  const [t] = await h.db
    .insert(inboxThreads)
    .values({ channel: "messenger", externalThreadId: psid, fromAddress: psid, lastMessageAt: new Date(now - lastInboundAgoMs), lastInboundAt: new Date(now - lastInboundAgoMs) })
    .returning();
  return t!;
}

const PAYLOADS: Record<string, () => Promise<unknown>> = {
  "crm.send_meta_reply": async () => {
    const t = await metaThread(HOUR);
    const [m] = await h.db.insert(inboxMessages).values({ threadId: t.id, direction: "out", body: "See you on Saturday!", occurredAt: new Date() }).returning();
    return { messageId: m!.id };
  },
  "crm.close_stale_threads": async () => {
    const old = new Date(Date.now() - 20 * DAY);
    await h.db.insert(inboxThreads).values({ channel: "email", externalThreadId: `<${randomUUID()}@example.com>`, status: "pending", lastMessageAt: old, lastInboundAt: old, createdAt: old });
    return {};
  },
  "crm.escalate_threads": async () => {
    // 30 days back: more than 24 opening hours under any opening-hours setting with open days.
    const p = await makePerson(h.db);
    const old = new Date(Date.now() - 30 * DAY);
    const [t] = await h.db.insert(inboxThreads).values({ channel: "email", externalThreadId: `<${randomUUID()}@example.com>`, personId: p.id, lastMessageAt: old, lastInboundAt: old }).returning();
    await h.db.insert(inboxMessages).values({ threadId: t!.id, direction: "in", body: "Anyone there?", externalMessageId: `<${randomUUID()}@example.com>`, occurredAt: old });
    return {};
  },
};

const EXPECTED_FIRST: Record<string, unknown> = {
  "crm.send_meta_reply": { status: "sent" },
  "crm.close_stale_threads": { resolved: 1 },
  "crm.escalate_threads": { escalated: 1 },
};

describe("crm inbox jobs run twice yield the same state", () => {
  it("defines every inbox kind", () => {
    for (const k of Object.keys(PAYLOADS)) expect(INBOX_JOBS.some((j) => j.kind === k), k).toBe(true);
  });

  it.each(Object.keys(PAYLOADS))("%s", async (kind) => {
    const payload = await PAYLOADS[kind]!();
    const sentBefore = fake.sent.length;
    let afterFirst: unknown;
    const { first, second } = await runJobTwice(h.db, kind as never, payload, {
      between: async () => {
        afterFirst = await snapshot();
      },
    });
    expect(first).toMatchObject(EXPECTED_FIRST[kind] as object);
    expect(await snapshot()).toEqual(afterFirst);
    if (kind === "crm.send_meta_reply") {
      expect(second).toMatchObject({ status: "already_sent" });
      expect(fake.sent.length - sentBefore).toBe(1);
    }
  });

  it("the meta webhook handler", async () => {
    const body = fake.webhookBody({ messages: [{ mid: `m_${randomUUID()}`, senderId: `psid-${randomUUID()}`, text: "Twice delivered" }] });
    let afterFirst: unknown;
    for (let i = 0; i < 2; i++) {
      let ctx: ReturnType<typeof makeJobCtx> | undefined;
      await h.db.transaction(async (tx) => {
        ctx = makeJobCtx(h.db, "webhook.process", { tx, attempt: i + 1 });
        await handleMetaWebhook(ctx, { id: randomUUID(), payload: body });
      });
      if (ctx) await flushDurableWrites(h.db, ctx);
      if (i === 0) afterFirst = await snapshot();
    }
    expect(await snapshot()).toEqual(afterFirst);
  });
});

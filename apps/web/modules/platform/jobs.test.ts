import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import { enqueue, type DbHandle } from "@beam/db";
import { authSessions, authVerificationTokens, files, jobs, monthlyReports, users, webhookEvents } from "@beam/db/schema";

vi.mock("@/registry/webhooks.generated", () => ({
  WEBHOOK_HANDLERS: {
    resend: {
      provider: "resend",
      // An idempotent handler: records the event once.
      handle: async (ctx: { tx: { execute: (q: unknown) => Promise<unknown> } }, event: { id: string }) => {
        const { sql } = await import("@/lib/ctx");
        await ctx.tx.execute(sql`insert into rate_limits (key, window_start, count, expires_at) values (${`handled:${event.id}`}, now(), 1, now() + interval '1 day') on conflict (key) do nothing`);
      },
    },
  },
}));

import { eq, sql } from "@/lib/ctx";
import { loadJobs } from "@/lib/job-runner";
import { decryptSensitive, encryptSensitive, sensitiveAad } from "@/lib/sensitive";
import { createFakeIntegrations, resetRuntime, runJobTwice } from "@/lib/testing";
import { jobs as platformJobs, previousMonthOn } from "./jobs";

let handle: DbHandle;
beforeAll(async () => {
  process.env.SENSITIVE_DATA_KEY_V1 = Buffer.alloc(32, 1).toString("base64");
  process.env.SENSITIVE_DATA_KEY_V2 = Buffer.alloc(32, 2).toString("base64");
  handle = await createTestDb();
});
afterAll(async () => {
  delete process.env.SENSITIVE_DATA_KEY_V2;
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`delete from jobs`);
  await handle.db.execute(sql`delete from rate_limits`);
});

const rows = async (q: ReturnType<typeof sql>) => ((await handle.db.execute(q)) as unknown as { rows: unknown[] }).rows;

/** Runs the job twice and asserts the state `snapshot` reads is the same after each run. */
async function twice(kind: Parameters<typeof runJobTwice>[1], payload: unknown, snapshot: () => Promise<unknown>) {
  let afterFirst: unknown;
  const result = await runJobTwice(handle.db, kind, payload, {
    integrations: createFakeIntegrations(),
    between: async () => {
      afterFirst = await snapshot();
    },
  });
  expect(await snapshot()).toEqual(afterFirst);
  return { ...result, afterFirst };
}

const jobState = () => rows(sql`select kind, idempotency_key, status from jobs order by idempotency_key`);

describe("every platform job run twice yields the same state", () => {
  it("covers every registered platform job", async () => {
    const registry = await loadJobs();
    for (const j of platformJobs) expect(registry[j.kind]).toBe(j);
  });

  it("webhook.process", async () => {
    const jobId = randomUUID();
    const [event] = await handle.db.insert(webhookEvents).values({ provider: "resend", externalEventId: `evt_${jobId}`, payload: { type: "email.delivered" }, jobId }).returning();
    const { afterFirst } = await twice("webhook.process", { webhookEventId: event!.id }, () => rows(sql`select key from rate_limits order by key`));
    expect(afterFirst).toEqual([{ key: `handled:${event!.id}` }]);
  });

  it("notify.slack", async () => {
    const integrations = createFakeIntegrations();
    const r = await runJobTwice(handle.db, "notify.slack", { fingerprint: "test", severity: "high", text: "Disk almost full" }, { integrations });
    expect(r.first).toEqual({ sent: true });
    expect(integrations.slack.messages[0]!.text).toContain("Disk almost full");
    expect(await jobState()).toEqual([]);
  });

  it("jobs.prune", async () => {
    const old = await enqueue(handle.db, { kind: "jobs.prune", payload: {}, key: "old" });
    await handle.db.update(jobs).set({ status: "succeeded", finishedAt: new Date(Date.now() - 8 * 86_400_000) }).where(eq(jobs.id, old.id));
    await enqueue(handle.db, { kind: "jobs.prune", payload: {}, key: "keep" });
    const { afterFirst } = await twice("jobs.prune", {}, jobState);
    expect(afterFirst).toEqual([{ kind: "jobs.prune", idempotency_key: "keep", status: "pending" }]);
  });

  it("files.purge_expired", async () => {
    const bytes = new Uint8Array([1]);
    const base = { kind: "export" as const, mime: "text/csv", sizeBytes: 1, bytes, sha256: "0".repeat(64) };
    await handle.db.insert(files).values({ ...base, name: "old.csv", expiresAt: new Date(Date.now() - 1000) });
    await handle.db.insert(files).values({ ...base, name: "new.csv", expiresAt: new Date(Date.now() + 86_400_000) });
    const { afterFirst } = await twice("files.purge_expired", {}, () => rows(sql`select name from files order by name`));
    expect(afterFirst).toEqual([{ name: "new.csv" }]);
  });

  it("platform.check_alerts", async () => {
    for (let i = 0; i < 501; i++) await enqueue(handle.db, { kind: "jobs.prune", payload: {}, key: `b:${i}`, runAt: new Date(Date.now() + 3_600_000) });
    const { afterFirst } = await twice("platform.check_alerts", {}, () => rows(sql`select idempotency_key from jobs where kind = 'notify.slack' order by 1`));
    expect((afterFirst as unknown[]).length).toBe(1);
  });

  it("platform.prune_ephemeral", async () => {
    const user = await makeUser(handle.db);
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 3_600_000);
    await handle.db.insert(authSessions).values({ sessionToken: "expired", userId: user.id, audience: "staff", expires: past, absoluteExpiresAt: future, createdAt: new Date(Date.now() - 10_000) });
    await handle.db.insert(authSessions).values({ sessionToken: "live", userId: user.id, audience: "staff", expires: future, absoluteExpiresAt: future });
    await handle.db.insert(authVerificationTokens).values({ identifier: "a@example.com", token: "t1", expires: past });
    await handle.db.execute(sql`insert into rate_limits (key, window_start, count, expires_at) values ('login:ip:x', now() - interval '2 hours', 3, now() - interval '1 hour')`);
    const { afterFirst } = await twice("platform.prune_ephemeral", {}, async () => ({
      sessions: await rows(sql`select session_token from auth_sessions order by 1`),
      tokens: await rows(sql`select token from auth_verification_tokens`),
      limits: await rows(sql`select key from rate_limits`),
    }));
    expect(afterFirst).toEqual({ sessions: [{ session_token: "live" }], tokens: [], limits: [] });
  });

  it("security.rekey", async () => {
    const user = await makeUser(handle.db);
    const enc = encryptSensitive("JBSWY3DPEHPK3PXP", sensitiveAad.totpSecret(user.id), 1);
    await handle.db.update(users).set({ totpSecretEnc: enc.valueEnc, secretKeyVersion: 1 }).where(eq(users.id, user.id));
    const snapshot = async () => {
      const [u] = await handle.db.select({ v: users.secretKeyVersion, enc: users.totpSecretEnc }).from(users).where(eq(users.id, user.id));
      return { version: u!.v, secret: decryptSensitive(u!.enc!, u!.v!, sensitiveAad.totpSecret(user.id)), next: await jobState() };
    };
    const { afterFirst } = await twice("security.rekey", { toVersion: 2, table: "users" }, snapshot);
    expect(afterFirst).toEqual({ version: 2, secret: "JBSWY3DPEHPK3PXP", next: [] });

    await handle.db.execute(sql`delete from jobs`);
    const { first } = await runJobTwice(handle.db, "security.rekey", { toVersion: 2, table: "person_sensitive_fields" });
    expect(first).toEqual({ rows: 0, next: "rekey:2:form_sensitive_answers:start" });
    expect(await jobState()).toEqual([{ kind: "security.rekey", idempotency_key: "rekey:2:form_sensitive_answers:start", status: "pending" }]);
  });

  it("platform.build_monthly_report", async () => {
    const monthOn = previousMonthOn(new Date());
    const { afterFirst } = await twice("platform.build_monthly_report", {}, () => rows(sql`select month_on::text as month_on, status, data - 'db_size_bytes' as data from monthly_reports`));
    const [report] = afterFirst as { month_on: string; status: string; data: { uptime_source: string; uptime_pct: number; dead_jobs: number } }[];
    expect(report).toMatchObject({ month_on: monthOn, status: "draft", data: { uptime_source: "betterstack", uptime_pct: 99.95, dead_jobs: 0 } });

    await handle.db.update(monthlyReports).set({ status: "sent" }).where(eq(monthlyReports.monthOn, monthOn));
    const { first } = await runJobTwice(handle.db, "platform.build_monthly_report", {});
    expect(first).toEqual({ monthOn, skipped: true });
  });
});

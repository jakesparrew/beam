import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { integrationCalls, jobs, webhookEvents } from "@beam/db/schema";
import { eq, sql } from "./ctx";
import { handleWebhook, type VerifyResult } from "./webhooks";
import { resetRuntime } from "./testing";

let handle: DbHandle;
beforeAll(async () => {
  handle = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});
beforeEach(async () => {
  await handle.db.execute(sql`set beam.allow_rewrite = 'on'`);
  await handle.db.execute(sql`delete from webhook_events`);
  await handle.db.execute(sql`delete from integration_calls`);
  await handle.db.execute(sql`reset beam.allow_rewrite`);
  await handle.db.execute(sql`delete from jobs`);
});

const request = (body: object, signature = "good") =>
  new Request("http://localhost/api/webhooks/resend", { method: "POST", body: JSON.stringify(body), headers: { "x-signature": signature } });

const verify = (raw: string, headers: Headers): Promise<VerifyResult> =>
  Promise.resolve(headers.get("x-signature") === "good" ? { ok: true, externalEventId: (JSON.parse(raw) as { id: string }).id, payload: JSON.parse(raw) as unknown } : { ok: false });

const call = (req: Request) => handleWebhook(req, { provider: "resend", verify, db: handle.db });

describe("handleWebhook (PL-37 to PL-39)", () => {
  it("stores the event and enqueues webhook.process with the stored job id", async () => {
    const res = await call(request({ id: "evt_1", type: "email.delivered" }));
    expect(res.status).toBe(200);
    const [event] = await handle.db.select().from(webhookEvents);
    expect(event).toMatchObject({ provider: "resend", externalEventId: "evt_1", payload: { id: "evt_1", type: "email.delivered" } });
    const [job] = await handle.db.select().from(jobs);
    expect(job).toMatchObject({ kind: "webhook.process", idempotencyKey: "webhook:resend:evt_1", payload: { webhookEventId: event!.id }, priority: 2 });
    expect(job!.id).toBe(event!.jobId);
  });

  it("a duplicate gets 200 and creates one event and one job", async () => {
    expect((await call(request({ id: "evt_2" }))).status).toBe(200);
    expect((await call(request({ id: "evt_2" }))).status).toBe(200);
    expect(await handle.db.select().from(webhookEvents)).toHaveLength(1);
    expect(await handle.db.select().from(jobs)).toHaveLength(1);
  });

  it("a bad signature gets 401, an integration_calls row and no event", async () => {
    const res = await call(request({ id: "evt_3" }, "bad"));
    expect(res.status).toBe(401);
    expect(await handle.db.select().from(webhookEvents)).toHaveLength(0);
    const [row] = await handle.db.select().from(integrationCalls);
    expect(row).toMatchObject({ provider: "resend", operation: "webhook.signature_failed", statusCode: 401, ok: false });
  });

  it("more than 5 signature failures in 10 minutes raise one Slack alert (5 raise none)", async () => {
    const slackJobs = () => handle.db.select().from(jobs).where(eq(jobs.kind, "notify.slack"));
    for (let i = 0; i < 5; i++) await call(request({ id: `bad_${i}` }, "bad"));
    expect(await slackJobs()).toHaveLength(0);
    await call(request({ id: "bad_5" }, "bad"));
    const slack = await slackJobs();
    expect(slack).toHaveLength(1);
    expect(slack[0]!.idempotencyKey).toMatch(/^slack:webhook-signature-resend:\d{4}-\d{2}-\d{2}T\d{2}$/);
    await call(request({ id: "bad_6" }, "bad"));
    expect(await slackJobs()).toHaveLength(1);
  });
});

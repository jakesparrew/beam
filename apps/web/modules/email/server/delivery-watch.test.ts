/**
 * email-P7: delivery watch (email spec rule 38a). A transactional message queued 11 minutes
 * alerts High; 9 minutes does not; a future `send_at` never alerts; 5 dead `email.send` jobs in
 * 15 minutes alert; no sends in an hour with 20 queued alert; a message turning
 * `blocked_translation` or `failed` posts one `normal` alert with fingerprint
 * `email:failed:<error>` and no address in the text, a `cancelled` message none; `getEmailHealth`
 * returns the values of (a) to (d).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { jobs } from "@beam/db/schema";
import { sql } from "@/lib/ctx";
import { makeJobCtx, resetRuntime } from "@/lib/testing";
import { getEmailHealth as apiEmailHealth } from "../api";
import { insertMessages, templateVersion, wipeMessages } from "../email-p7.fixtures";
import { getEmailHealth, watchDelivery } from "./delivery-watch";

let h: DbHandle;
let versionId: string;
let slug: string;

const MIN = 60_000;
const now = new Date("2026-11-05T10:20:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * MIN);

beforeAll(async () => {
  h = await createTestDb();
  ({ versionId, slug } = await templateVersion(h.db, "transactional"));
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});
beforeEach(async () => {
  await wipeMessages(h.db);
  await h.db.execute(sql`delete from jobs`);
});

const transactional = (n: number, values: Record<string, unknown>, each?: (i: number) => Record<string, unknown>) =>
  insertMessages(h.db, n, { templateVersionId: versionId, kind: "transactional", purpose: null, fromDomain: "mail.beam.be", status: "queued", toEmail: "p7-watch@example.com", ...values }, each);

const slack = async (prefix: string) => (await h.db.select().from(jobs).where(sql`${jobs.kind} = 'notify.slack'`)).filter((j) => (j.payload as { fingerprint: string }).fingerprint.startsWith(prefix));
const watch = () => watchDelivery(makeJobCtx(h.db, "email.watch_delivery", { now }));

describe("email.watch_delivery", () => {
  it("(a) a transactional message queued 11 minutes alerts High", async () => {
    await transactional(1, { queuedAt: ago(11) });
    expect((await watch()).checks).toEqual(["queued"]);
    const [alert] = await slack("email:delivery:");
    expect(alert!.payload).toMatchObject({ fingerprint: "email:delivery:queued", severity: "high" });
    expect((await getEmailHealth(h.db, now)).oldestQueuedMinutes).toBe(11);
  });

  it("(a) one queued 9 minutes does not", async () => {
    await transactional(1, { queuedAt: ago(9) });
    expect((await watch()).checks).toEqual([]);
    expect(await slack("email:delivery:")).toHaveLength(0);
  });

  it("(a) a future send_at never alerts, even when queued long ago", async () => {
    await transactional(1, { queuedAt: ago(3 * 24 * 60), sendAt: new Date(now.getTime() + 24 * 60 * MIN) });
    expect((await watch()).checks).toEqual([]);
    expect((await getEmailHealth(h.db, now)).oldestQueuedMinutes).toBeNull();
  });

  it("(b) 5 dead email.send jobs in 15 minutes alert", async () => {
    await h.db.insert(jobs).values(
      Array.from({ length: 5 }, (_, i) => ({ kind: "email.send", payload: {}, idempotencyKey: `p7-dead-${i}`, status: "dead" as const, updatedAt: ago(i + 1) })),
    );
    await h.db.insert(jobs).values({ kind: "email.send", payload: {}, idempotencyKey: "p7-dead-old", status: "dead" as const, updatedAt: ago(30) });
    expect((await getEmailHealth(h.db, now)).deadSends15m).toBe(5);
    expect((await watch()).checks).toEqual(["dead_sends"]);
    expect((await slack("email:delivery:dead_sends")).length).toBe(1);
  });

  it("(b) 4 dead jobs do not alert", async () => {
    await h.db.insert(jobs).values(Array.from({ length: 4 }, (_, i) => ({ kind: "email.send", payload: {}, idempotencyKey: `p7-dead4-${i}`, status: "dead" as const, updatedAt: ago(2) })));
    expect((await watch()).checks).toEqual([]);
  });

  it("(c) nothing sent in 60 minutes while 20 were queued alerts", async () => {
    await insertMessages(h.db, 20, { templateVersionId: versionId, status: "queued", queuedAt: ago(5) });
    expect((await watch()).checks).toContain("not_sending");
    await insertMessages(h.db, 1, { templateVersionId: versionId, status: "sent", sentAt: ago(3) });
    expect((await watch()).checks).not.toContain("not_sending");
  });

  it("(d) failed and blocked messages post one normal alert per error, without addresses; cancelled posts none", async () => {
    await transactional(2, { status: "failed", error: "resend_4xx:422", updatedAt: ago(1), sentAt: null });
    await transactional(1, { status: "blocked_translation", updatedAt: ago(2) });
    await transactional(1, { status: "failed", error: "cancelled", updatedAt: ago(1) });
    await transactional(1, { status: "failed", error: "no_recipient", updatedAt: ago(20) });
    const health = await getEmailHealth(h.db, now);
    expect(health).toMatchObject({ failed5m: 2, blockedTranslation5m: 1 });
    await watch();
    await watch();
    const failed = await slack("email:failed:");
    expect(failed.map((j) => (j.payload as { fingerprint: string }).fingerprint).sort()).toEqual(["email:failed:blocked_translation", "email:failed:resend_4xx:422"]);
    for (const j of failed) {
      const payload = j.payload as { severity: string; text: string };
      expect(payload.severity).toBe("normal");
      expect(payload.text).not.toContain("@");
      expect(payload.text).toContain(slug);
    }
    const resend4xx = failed.find((j) => (j.payload as { fingerprint: string }).fingerprint === "email:failed:resend_4xx:422")!;
    expect((resend4xx.payload as { text: string }).text).toContain("2 emails");
  });

  it("getEmailHealth reports every value and the api returns the same", async () => {
    await transactional(1, { queuedAt: ago(15) });
    await insertMessages(h.db, 3, { templateVersionId: versionId, status: "sent", sentAt: ago(30) });
    await transactional(1, { status: "failed", error: "invalid_template_data", updatedAt: ago(1) });
    const expected = { oldestQueuedMinutes: 15, deadSends15m: 0, sent60m: 3, failed5m: 1, blockedTranslation5m: 0 };
    expect(await getEmailHealth(h.db, now)).toEqual(expected);
    expect(await apiEmailHealth(h.db, now)).toEqual(expected);
  });
});

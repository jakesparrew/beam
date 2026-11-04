import { describe, expect, it } from "vitest";
import { createFakeResendClient, FAKE_RESEND_WEBHOOK_SECRET } from "./fake";
import { computeResendSignature, resendWebhookVerifier, signResendWebhook, verifyResendWebhook } from "./webhook";

const secret = `whsec_${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64")}`;
const now = new Date("2026-11-03T10:00:00Z");
const ts = String(Math.floor(now.getTime() / 1000));
const body = JSON.stringify({ type: "email.delivered", created_at: now.toISOString(), data: { email_id: "re_fake_1" } });
const id = "msg_2abc";

describe("verifyResendWebhook (rule 45)", () => {
  it("accepts a valid signature", () => {
    const signature = signResendWebhook({ id, timestamp: ts, body, secret });
    expect(signature).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(verifyResendWebhook({ id, timestamp: ts, signature, body, secret, now })).toBe(true);
  });

  it("refuses a signature made with the wrong secret", () => {
    const other = `whsec_${Buffer.from("another-secret-another-secret-00").toString("base64")}`;
    const signature = signResendWebhook({ id, timestamp: ts, body, secret: other });
    expect(verifyResendWebhook({ id, timestamp: ts, signature, body, secret, now })).toBe(false);
  });

  it("refuses a changed body, id or timestamp", () => {
    const signature = signResendWebhook({ id, timestamp: ts, body, secret });
    expect(verifyResendWebhook({ id, timestamp: ts, signature, body: body.replace("delivered", "bounced"), secret, now })).toBe(false);
    expect(verifyResendWebhook({ id: "msg_other", timestamp: ts, signature, body, secret, now })).toBe(false);
    expect(verifyResendWebhook({ id, timestamp: String(Number(ts) + 1), signature, body, secret, now })).toBe(false);
  });

  it("refuses a stale or future timestamp beyond 5 minutes, accepts within", () => {
    const at = (offsetSeconds: number) => String(Number(ts) + offsetSeconds);
    for (const [offset, ok] of [
      [-301, false],
      [301, false],
      [-299, true],
      [299, true],
    ] as const) {
      const timestamp = at(offset);
      const signature = signResendWebhook({ id, timestamp, body, secret });
      expect(verifyResendWebhook({ id, timestamp, signature, body, secret, now })).toBe(ok);
    }
    expect(verifyResendWebhook({ id, timestamp: "not-a-number", signature: "v1,x", body, secret, now })).toBe(false);
  });

  it("accepts any matching v1 signature among several (key rotation) and ignores other versions", () => {
    const good = computeResendSignature({ id, timestamp: ts, body, secret });
    const stale = computeResendSignature({ id, timestamp: ts, body, secret: `whsec_${Buffer.from("old-secret-old-secret-old-secret").toString("base64")}` });
    expect(verifyResendWebhook({ id, timestamp: ts, signature: `v1,${stale} v1,${good}`, body, secret, now })).toBe(true);
    expect(verifyResendWebhook({ id, timestamp: ts, signature: `v1,${stale} v2,${good}`, body, secret, now })).toBe(false);
    expect(verifyResendWebhook({ id, timestamp: ts, signature: "", body, secret, now })).toBe(false);
  });

  it("adapts to handleWebhook: reads svix headers and returns svix-id and the payload", async () => {
    const verify = resendWebhookVerifier(secret, { now: () => now });
    const headers = new Headers({ "svix-id": id, "svix-timestamp": ts, "svix-signature": signResendWebhook({ id, timestamp: ts, body, secret }) });
    expect(await verify(body, headers)).toEqual({ ok: true, externalEventId: id, payload: JSON.parse(body) as unknown });
    headers.set("svix-signature", "v1,AAAA");
    expect(await verify(body, headers)).toEqual({ ok: false });
    expect(await verify(body, new Headers())).toEqual({ ok: false });
  });

  it("verifies the fake's signed webhook bodies", async () => {
    const fake = createFakeResendClient({ now: () => now });
    const { id: resendId } = await fake.sendEmail({ from: "BEAM <hello@mail.beam.be>", to: "a@example.com", subject: "Hi", html: "<p>Hi</p>", text: "Hi", headers: {}, idempotencyKey: "email:1" });
    const delivery = fake.emitWebhook("email.bounced", resendId, { bounce: { type: "Permanent", subType: "General", message: "unknown user" } });
    expect(delivery.payload).toMatchObject({ type: "email.bounced", data: { email_id: resendId, to: ["a@example.com"], bounce: { type: "Permanent" } } });
    const verify = resendWebhookVerifier(FAKE_RESEND_WEBHOOK_SECRET, { now: () => now });
    expect(await verify(delivery.body, new Headers(delivery.headers))).toMatchObject({ ok: true, externalEventId: delivery.id });
    expect(fake.emitWebhook("email.delivered", resendId).id).not.toBe(delivery.id);
  });
});

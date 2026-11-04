/** fix-w09-email-review (V1 review finding 3): the deterministic per-message link token. */
import { describe, expect, it } from "vitest";
import { hashLinkToken, isLinkTokenShape, linkTokenFor } from "./links";

const EXPECTED = "cGairV1g94-EVFUFDNsePl8yzwVoWIe2NYr-g8k-REo";

describe("linkTokenFor", () => {
  it("is base64url(HMAC-SHA256(secret, 'email-link:<id>')) in the link-token shape, with its sha256", async () => {
    const id = "6f1c2a52-6a0e-4c43-9c39-6b1a3a8e2f10";
    const t = await linkTokenFor(id, "test-secret");
    expect(isLinkTokenShape(t.token)).toBe(true);
    // Reference value: Node's createHmac("sha256", "test-secret").update(`email-link:${id}`).digest("base64url").
    expect(t.token).toBe(EXPECTED);
    expect(t.hash).toBe(hashLinkToken(t.token));
  });

  it("is stable per message and differs per message and per secret", async () => {
    const a = await linkTokenFor("m-1", "s");
    expect(await linkTokenFor("m-1", "s")).toEqual(a);
    expect((await linkTokenFor("m-2", "s")).token).not.toBe(a.token);
    expect((await linkTokenFor("m-1", "other")).token).not.toBe(a.token);
  });

  it("refuses an empty secret or id", async () => {
    await expect(linkTokenFor("m-1", "")).rejects.toThrow(/secret/);
    await expect(linkTokenFor("", "s")).rejects.toThrow(/message id/);
  });
});

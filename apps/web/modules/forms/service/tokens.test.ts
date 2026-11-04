/** forms-P3: identity, result, embed context and fsid tokens (rules ID5, ID6, A1). */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { setupEnv } from "../forms-p3.fixtures";
import {
  createIdentityToken,
  createResultToken,
  hashIp,
  hashToken,
  signEmbedContext,
  signSubmissionId,
  verifyEmbedContext,
  verifyIdentityToken,
  verifySubmissionCookie,
} from "./tokens";

beforeAll(setupEnv);

const flip = (s: string, at: number): string => s.slice(0, at) + (s[at] === "A" ? "B" : "A") + s.slice(at + 1);

describe("identity tokens (ID5)", () => {
  it("round-trips the payload and carries s only for staff entry", () => {
    const personId = randomUUID();
    const now = new Date("2026-11-04T10:00:00Z");
    const t = createIdentityToken({ personId, formSlug: "contact", ttlSeconds: 30 * 86_400, now });
    expect(verifyIdentityToken(t, now)).toEqual({ personId, formSlug: "contact", expiresAt: new Date("2026-12-04T10:00:00Z"), staffUserId: null });
    const staff = randomUUID();
    const s = createIdentityToken({ personId, formSlug: null, ttlSeconds: 7200, staffUserId: staff, now });
    expect(verifyIdentityToken(s, now)).toMatchObject({ personId, formSlug: null, staffUserId: staff });
    const payload = JSON.parse(Buffer.from(s.split(".")[0]!, "base64url").toString()) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["e", "f", "p", "s"]);
  });

  it("rejects a tampered payload, a tampered signature, garbage and an expired token", () => {
    const now = new Date("2026-11-04T10:00:00Z");
    const t = createIdentityToken({ personId: randomUUID(), formSlug: "contact", ttlSeconds: 60, now });
    const [body, sig] = t.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ p: randomUUID(), f: "contact", e: 9_999_999_999 })).toString("base64url");
    expect(verifyIdentityToken(`${forged}.${sig}`, now)).toBeNull();
    expect(verifyIdentityToken(`${body}.${flip(sig, 3)}`, now)).toBeNull();
    expect(verifyIdentityToken("not-a-token", now)).toBeNull();
    expect(verifyIdentityToken("", now)).toBeNull();
    expect(verifyIdentityToken(t, new Date(now.getTime() + 61_000))).toBeNull();
    expect(verifyIdentityToken(t, new Date(now.getTime() + 59_000))).not.toBeNull();
  });
});

describe("result tokens (ID6)", () => {
  it("are deterministic, 43 chars, and revoked by a version bump", () => {
    const id = randomUUID();
    const a = createResultToken(id, 1);
    expect(a).toHaveLength(43);
    expect(createResultToken(id, 1)).toBe(a);
    expect(createResultToken(id, 2)).not.toBe(a);
    expect(createResultToken(randomUUID(), 1)).not.toBe(a);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("depend on AUTH_SECRET", () => {
    const id = randomUUID();
    const a = createResultToken(id, 1);
    process.env.AUTH_SECRET = "another-secret";
    try {
      expect(createResultToken(id, 1)).not.toBe(a);
    } finally {
      setupEnv();
    }
  });
});

describe("embedContext (A1)", () => {
  it("verifies a signed context and ignores a tampered or unsigned one", () => {
    const ctx = { pagePath: "/nl/sauna", referrer: "https://www.google.com/search", partnerCompanyId: randomUUID(), utm: { source: "fb" } };
    const signed = signEmbedContext(ctx);
    expect(verifyEmbedContext(signed)).toEqual(ctx);
    const [, sig] = signed.split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ ...ctx, partnerCompanyId: randomUUID() })).toString("base64url");
    expect(verifyEmbedContext(`${forged}.${sig}`)).toBeNull();
    expect(verifyEmbedContext(Buffer.from(JSON.stringify(ctx)).toString("base64url"))).toBeNull();
    expect(verifyEmbedContext(undefined)).toBeNull();
  });

  it("an identity token is not a valid embed context (separate keys)", () => {
    const t = createIdentityToken({ personId: randomUUID(), ttlSeconds: 60 });
    expect(verifyEmbedContext(t)).toBeNull();
  });
});

describe("fsid and ip hash", () => {
  it("signs a submission id and refuses another id", () => {
    const id = randomUUID();
    expect(verifySubmissionCookie(signSubmissionId(id))).toBe(id);
    const other = signSubmissionId(randomUUID()).split(".")[1];
    expect(verifySubmissionCookie(`${id}.${other}`)).toBeNull();
  });

  it("hashes an IP without storing it", () => {
    expect(hashIp("203.0.113.5")).toBe(hashIp(" 203.0.113.5 "));
    expect(hashIp("203.0.113.5")).not.toContain("203");
  });
});

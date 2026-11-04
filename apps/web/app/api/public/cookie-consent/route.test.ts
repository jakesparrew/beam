import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, makeUser } from "@beam/db/testing";
import type { DbHandle } from "@beam/db";
import { cookieConsents } from "@beam/db/schema";
import { decodeConsentCookie } from "@beam/core/site";
import { eq, setAppDb } from "@/lib/ctx";
import { createAuthSession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/auth-config";
import { resetRuntime } from "@/lib/testing";
import { POST } from "./route";

let handle: DbHandle;
let ipCounter = 1;

beforeAll(async () => {
  handle = await createTestDb();
  setAppDb(handle.db);
});
afterAll(async () => {
  resetRuntime();
  await handle.close();
});

function post(body: unknown, init: { cookie?: string; ip?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": init.ip ?? `203.0.113.${ipCounter++}` };
  if (init.cookie) headers.cookie = init.cookie;
  return POST(new Request("http://localhost/api/public/cookie-consent", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }));
}

const valid = { action: "accept_all", choices: { analytics: true, marketing: true }, bannerVersion: 2, locale: "nl-BE" };

describe("POST /api/public/cookie-consent", () => {
  it("inserts one row and sets the consent cookie with its attributes", async () => {
    const res = await post(valid);
    expect(res.status).toBe(200);
    const { consentKey } = (await res.json()) as { consentKey: string };
    expect(consentKey).toMatch(/^[0-9a-f-]{36}$/);
    const rows = await handle.db.select().from(cookieConsents).where(eq(cookieConsents.consentKey, consentKey));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "accept_all", choices: { analytics: true, marketing: true }, bannerVersion: 2, locale: "nl-BE", personId: null });

    const setCookie = res.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/^beam_consent=[^;]+; /);
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain("Max-Age=15724800");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    expect(setCookie).not.toMatch(/HttpOnly/i);
    const cookie = decodeConsentCookie(setCookie.split(";")[0]!.split("=")[1]);
    expect(cookie).toMatchObject({ k: consentKey, v: 2, a: true, m: true });
    expect(Math.abs(cookie!.t - Date.now() / 1000)).toBeLessThan(60);
  });

  it("keeps the visitor's consent key and appends a row per choice; withdraw clears every category", async () => {
    const consentKey = randomUUID();
    expect((await post({ ...valid, consentKey, action: "custom", choices: { analytics: true, marketing: false } })).status).toBe(200);
    const res = await post({ ...valid, consentKey, action: "withdraw", choices: { analytics: true, marketing: true } });
    expect(((await res.json()) as { consentKey: string }).consentKey).toBe(consentKey);
    const rows = await handle.db.select().from(cookieConsents).where(eq(cookieConsents.consentKey, consentKey));
    expect(rows.map((r) => [r.action, r.choices]).sort()).toEqual([
      ["custom", { analytics: true, marketing: false }],
      ["withdraw", { analytics: false, marketing: false }],
    ]);
    expect(decodeConsentCookie(res.headers.get("set-cookie")!.split(";")[0]!.split("=")[1])).toMatchObject({ a: false, m: false });
  });

  it("links the person when a customer session exists", async () => {
    const user = await makeUser(handle.db, { audience: "customer" });
    const { token } = await createAuthSession(handle.db, { userId: user.id, audience: "customer", roleKey: null, now: new Date() });
    const res = await post({ ...valid, action: "reject_all", choices: { analytics: true, marketing: true } }, { cookie: `other=1; ${SESSION_COOKIE}=${token}` });
    expect(res.status).toBe(200);
    const { consentKey } = (await res.json()) as { consentKey: string };
    const [row] = await handle.db.select().from(cookieConsents).where(eq(cookieConsents.consentKey, consentKey));
    expect(row!.personId).toBe(user.personId);
    expect(row!.choices).toEqual({ analytics: false, marketing: false });
  });

  it("ignores an unknown session token (no person, still recorded)", async () => {
    const res = await post(valid, { cookie: `${SESSION_COOKIE}=not-a-session` });
    const { consentKey } = (await res.json()) as { consentKey: string };
    const [row] = await handle.db.select().from(cookieConsents).where(eq(cookieConsents.consentKey, consentKey));
    expect(row!.personId).toBeNull();
  });

  it("answers 400 for an invalid body and writes nothing", async () => {
    const before = (await handle.db.select().from(cookieConsents)).length;
    for (const body of [
      "{not json",
      { ...valid, action: "maybe" },
      { ...valid, choices: { analytics: "yes", marketing: false } },
      { ...valid, bannerVersion: -1 },
      { ...valid, locale: "de" },
      { ...valid, consentKey: "abc" },
      { action: "accept_all" },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect((await handle.db.select().from(cookieConsents)).length).toBe(before);
  });

  it("stores the IP only as an HMAC with AUTH_SECRET (first 32 hex characters)", async () => {
    const ip = "198.51.100.23";
    const res = await post(valid, { ip });
    const { consentKey } = (await res.json()) as { consentKey: string };
    const [row] = await handle.db.select().from(cookieConsents).where(eq(cookieConsents.consentKey, consentKey));
    const expected = createHmac("sha256", process.env.AUTH_SECRET ?? "").update(ip).digest("hex").slice(0, 32);
    expect(row!.ipHash).toBe(expected);
    expect(row!.ipHash).toHaveLength(32);
    expect(JSON.stringify(row)).not.toContain(ip);
  });
});

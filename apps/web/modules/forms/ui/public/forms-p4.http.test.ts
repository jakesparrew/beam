/** forms-P4: `http.ts` helpers (IP from `x-forwarded-for`, cookies, the `fsid` cookie, error mapping). */
import { describe, expect, it } from "vitest";
import { ConflictError, NotFoundError, RateLimitedError, ValidationError } from "@/lib/ctx";
import { setupEnv } from "../../forms-p3.fixtures";
import { FormClosedError } from "../../service/submissions";
import { verifySubmissionCookie } from "../../service/tokens";
import { clientIp, fsidCookie, readCookie, toErrorResponse } from "./http";

setupEnv();

const r = (headers: Record<string, string>) => new Request("https://app.example.com/api/public/forms/x/start", { headers });

describe("http.ts", () => {
  it("takes the client IP from the first x-forwarded-for entry, then x-real-ip", () => {
    expect(clientIp(r({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientIp(r({ "x-real-ip": "198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientIp(r({}))).toBe("unknown");
  });

  it("reads one cookie and builds the signed fsid cookie", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const cookie = fsidCookie(id);
    expect(cookie).toContain("HttpOnly; Secure; SameSite=None");
    const value = cookie.split(";")[0]!;
    expect(verifySubmissionCookie(readCookie(r({ cookie: `a=1; ${value}; b=2` }), "fsid"))).toBe(id);
    expect(readCookie(r({ cookie: "a=1" }), "fsid")).toBeNull();
  });

  it("maps errors to the section 4 statuses", async () => {
    expect(toErrorResponse(new FormClosedError(), { route: "t" }).status).toBe(410);
    expect(toErrorResponse(new NotFoundError(), { route: "t" }).status).toBe(404);
    expect(toErrorResponse(new ConflictError(), { route: "t" }).status).toBe(409);
    const v = toErrorResponse(new ValidationError("validation", { email: "invalid_email" }), { route: "t" });
    expect(v.status).toBe(400);
    expect(await v.json()).toEqual({ ok: false, error: { code: "validation", message: "validation", fields: { email: "invalid_email" } } });
    const limited = toErrorResponse(new RateLimitedError(120), { route: "t" });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("120");
    const internal = toErrorResponse(new Error("boom"), { route: "t", requestId: "req_1" });
    expect(internal.status).toBe(500);
    expect(await internal.json()).toEqual({ ok: false, error: { code: "internal", message: "req_1" } });
  });
});

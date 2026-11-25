import { describe, expect, it } from "vitest";
import { IntegrationError, type IntegrationCallEntry } from "../_shared";
import { createWebinarGeekClient } from "./client";
import { createWebinarGeekFake } from "./fake";

describe("createWebinarGeekClient (injected fetch, no network)", () => {
  it("posts the subscriber to the broadcast with the Api-Token header and returns the watch link", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const entries: IntegrationCallEntry[] = [];
    const client = createWebinarGeekClient({
      apiToken: "tok",
      onCall: (e) => void entries.push(e),
      fetch: (url, init) => {
        seen.push({ url: String(url), init: init! });
        return Promise.resolve(new Response(JSON.stringify({ id: 991, watch_link: "https://beam.webinargeek.com/watch/abc" }), { status: 201 }));
      },
    });
    const sub = await client.subscribe("123", { email: "an@example.com", firstName: "An", lastName: "Peeters", externalId: "bk-1" });
    expect(sub).toEqual({ id: "991", watchUrl: "https://beam.webinargeek.com/watch/abc" });
    expect(seen[0]!.url).toBe("https://app.webinargeek.com/api/v2/broadcasts/123/subscriptions");
    expect(seen[0]!.init.method).toBe("POST");
    expect((seen[0]!.init.headers as Record<string, string>)["api-token"]).toBe("tok");
    expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ firstname: "An", surname: "Peeters", email: "an@example.com", external_id: "bk-1" });
    expect(entries).toMatchObject([{ provider: "webinargeek", operation: "subscriptions.create", ok: true, statusCode: 201 }]);
  });

  it("treats 401/403 as permanent and 5xx as retryable", async () => {
    const withStatus = (status: number) => createWebinarGeekClient({ apiToken: "x", fetch: () => Promise.resolve(new Response("nope", { status })) });
    await expect(withStatus(403).subscribe("1", { email: "a@b.be", firstName: "A" })).rejects.toMatchObject({ retryable: false, statusCode: 403 });
    await expect(withStatus(503).subscribe("1", { email: "a@b.be", firstName: "A" })).rejects.toMatchObject({ retryable: true, statusCode: 503 });
  });
});

describe("createWebinarGeekFake", () => {
  it("keeps one subscription per email per broadcast and can fail", async () => {
    const fake = createWebinarGeekFake();
    const a = await fake.subscribe("7", { email: "An@example.com", firstName: "An" });
    const b = await fake.subscribe("7", { email: "an@example.com", firstName: "An" });
    expect(b).toEqual(a);
    expect(a.watchUrl).toMatch(/^https:\/\//);
    expect(fake.subscriptions).toHaveLength(1);
    fake.failNext(500);
    await expect(fake.subscribe("7", { email: "x@y.be", firstName: "X" })).rejects.toBeInstanceOf(IntegrationError);
  });
});

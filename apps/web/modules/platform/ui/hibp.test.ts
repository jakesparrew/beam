import { describe, expect, it, vi } from "vitest";
import { checkPwnedPassword, HIBP_RANGE_URL, rangeContains, sha1Hex } from "./hibp";

// sha1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
const PREFIX = "5BAA6";
const SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";

const respond = (body: string, status = 200) => vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(body, { status })));

describe("HIBP range check (PL-1)", () => {
  it("hashes with SHA-1 and sends only the 5-character prefix with padding", async () => {
    expect(await sha1Hex("password")).toBe(PREFIX + SUFFIX);
    const fetch = respond("0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n");
    await checkPwnedPassword("password", { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`${HIBP_RANGE_URL}${PREFIX}`);
    expect(new Headers(init?.headers).get("Add-Padding")).toBe("true");
    expect(url).not.toContain(SUFFIX);
  });

  it("reports a breached password when the suffix is listed", async () => {
    const fetch = respond(`0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${SUFFIX}:3861493\r\n`);
    expect(await checkPwnedPassword("password", { fetch: fetch as unknown as typeof globalThis.fetch })).toBe("breached");
  });

  it("answers ok when the suffix is absent or only a padding row (count 0)", async () => {
    const absent = respond("0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n");
    expect(await checkPwnedPassword("password", { fetch: absent as unknown as typeof globalThis.fetch })).toBe("ok");
    expect(rangeContains(`${SUFFIX}:0`, SUFFIX)).toBe(false);
  });

  it("allows submit on timeout or error", async () => {
    // Fake timers: the abort comes from the injected timeout, never from a real wait (and a
    // loaded machine cannot make the abort fire before the request exists).
    vi.useFakeTimers();
    try {
      const hang = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            if (init?.signal?.aborted) return reject(new Error("aborted"));
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const verdict = checkPwnedPassword("password", { fetch: hang as unknown as typeof globalThis.fetch, timeoutMs: 1500 });
      await vi.waitFor(() => expect(hang).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1500);
      expect(await verdict).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
    const failing = respond("busy", 503);
    expect(await checkPwnedPassword("password", { fetch: failing as unknown as typeof globalThis.fetch })).toBe("unknown");
    const throwing = vi.fn(() => Promise.reject(new TypeError("network")));
    expect(await checkPwnedPassword("password", { fetch: throwing as unknown as typeof globalThis.fetch })).toBe("unknown");
  });
});

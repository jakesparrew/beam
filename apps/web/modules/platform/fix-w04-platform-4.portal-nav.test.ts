// Review fixes of fix-w04-platform-4: the portal layout hides nav entries whose flag is off (ops-P1 request).
import { describe, expect, it } from "vitest";
import { visiblePortalEntries, type PortalNavEntry } from "./portal-nav";

const entry = (key: string, order: number, flag?: string): PortalNavEntry => ({ key, href: `/nl/account/${key}`, labelKey: `x.${key}`, icon: "x", order, ...(flag ? { flag } : {}) });

describe("visiblePortalEntries", () => {
  it("keeps unflagged entries and flagged ones that are on, in order", async () => {
    const on = new Set(["shop"]);
    const shown = await visiblePortalEntries([entry("b", 2), entry("shop", 1, "shop"), entry("webinars", 0, "webinars"), entry("a", 2)], (f) => Promise.resolve(on.has(f)));
    expect(shown.map((e) => e.key)).toEqual(["shop", "a", "b"]);
  });

  it("hides an entry whose flag check throws", async () => {
    const shown = await visiblePortalEntries([entry("x", 1, "broken")], () => Promise.reject(new Error("db down")));
    expect(shown).toEqual([]);
  });
});

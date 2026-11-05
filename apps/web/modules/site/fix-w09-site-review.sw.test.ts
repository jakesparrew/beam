/**
 * fix-w09-site-review: the service worker (`app/sw.ts`, site spec section 5, edge case 24) never
 * stores or serves from cache a personal navigation (portal, checkout return, payment link, claim,
 * preference centre, staff preview, gift, form resume), and deletes such pages an earlier worker
 * stored. Serwist is replaced by a recorder of the config the worker builds.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

type Matcher = (o: { request: { mode: string; destination: string }; url: URL; sameOrigin: boolean }) => boolean;
type Route = { matcher: Matcher; handler: { kind: string; cacheName?: string } };
type ActivateListener = (event: { waitUntil(p: Promise<unknown>): void }) => void;

const state = vi.hoisted(() => ({ runtimeCaching: [] as unknown[], navigationPreload: undefined as boolean | undefined, listeners: new Map<string, unknown>() }));

vi.mock("serwist", () => {
  const strategy = (kind: string) =>
    class {
      kind = kind;
      cacheName?: string;
      constructor(opts?: { cacheName?: string }) {
        this.cacheName = opts?.cacheName;
      }
    };
  return {
    CacheFirst: strategy("CacheFirst"),
    NetworkFirst: strategy("NetworkFirst"),
    NetworkOnly: strategy("NetworkOnly"),
    StaleWhileRevalidate: strategy("StaleWhileRevalidate"),
    ExpirationPlugin: class {},
    Serwist: class {
      constructor(config: { runtimeCaching: unknown[]; navigationPreload?: boolean }) {
        state.runtimeCaching = config.runtimeCaching;
        state.navigationPreload = config.navigationPreload;
      }
      addEventListeners() {}
    },
  };
});

const stored = new Map<string, Request>();
beforeAll(async () => {
  vi.stubGlobal("self", { __SW_MANIFEST: [], addEventListener: (type: string, fn: unknown) => void state.listeners.set(type, fn) });
  vi.stubGlobal("caches", {
    open: () =>
      Promise.resolve({
        keys: () => Promise.resolve([...stored.values()]),
        delete: (r: Request) => Promise.resolve(stored.delete(r.url)),
      }),
  });
  await import("@/app/sw");
});

function handlerFor(path: string): string | null {
  const url = new URL(path, "https://beam.example.com");
  const route = (state.runtimeCaching as Route[]).find((r) => r.matcher({ request: { mode: "navigate", destination: "document" }, url, sameOrigin: true }));
  return route ? `${route.handler.kind}${route.handler.cacheName ? `:${route.handler.cacheName}` : ""}` : null;
}

describe("service worker navigations", () => {
  it("keeps navigation preload off, so a GET with a side effect (a magic link) is sent once", () => {
    // With preload on, the browser preloads every navigation, /api/* included, and fetches it again
    // when no route answers: the magic-link callback consumed its token twice (final e2e gate).
    expect(state.navigationPreload).not.toBe(true);
  });

  it("never caches personal pages (network-only)", () => {
    for (const path of [
      "/nl/account",
      "/fr/account/bookings",
      "/nl/checkout/return/3f1c2a4e-0000-4000-8000-000000000001",
      "/en/pay/tok123",
      "/nl/claim/tok123",
      "/fr/preferences/tok123",
      "/nl/preview/3f1c2a4e-0000-4000-8000-000000000002",
      "/nl/gift",
      "/nl/f/intake/r/tok123",
    ]) {
      expect(handlerFor(path), path).toBe("NetworkOnly");
    }
  });

  it("keeps public content pages network-first in the pages cache", () => {
    for (const path of ["/nl", "/nl/dagsessies", "/fr/blog/un-article", "/nl/f/intake", "/nl/checkout-info", "/nl/preferences-uitleg"]) {
      expect(handlerFor(path), path).toBe("NetworkFirst:pages");
    }
  });

  it("deletes personal pages a previous worker stored, on activation", async () => {
    for (const p of ["/nl/dagsessies", "/nl/checkout/return/x", "/nl/preferences/tok", "/nl/preview/v"]) {
      const r = new Request(`https://beam.example.com${p}`);
      stored.set(r.url, r);
    }
    let pending: Promise<unknown> = Promise.resolve();
    (state.listeners.get("activate") as ActivateListener)({ waitUntil: (p) => void (pending = p) });
    await pending;
    expect([...stored.keys()]).toEqual(["https://beam.example.com/nl/dagsessies"]);
  });
});

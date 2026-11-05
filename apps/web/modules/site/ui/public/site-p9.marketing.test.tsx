// @vitest-environment jsdom
/**
 * site-P9 (R3) in the browser: no marketing tag and no `beam_ref` cookie without marketing
 * consent; with it the Google Ads tag and the Meta Pixel load with the nonce, a completed form is
 * a conversion, and `beam_ref` keeps the first code; without consent the code rides only on the
 * page view's portal, checkout and form links.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeConsentCookie } from "@beam/core/site";

vi.mock("next/script", () => ({
  default: (props: { id?: string; src?: string; nonce?: string }) => <script data-testid={props.id} data-src={props.src} data-nonce={props.nonce} />,
}));
const nav = { pathname: "/nl/actie" };
vi.mock("next/navigation", () => ({ usePathname: () => nav.pathname }));

const { ConsentProvider } = await import("./consent-provider");
const { AnalyticsLoader, initGtag, initMarketingTags, revokeMarketingTags, trackMarketingConversion } = await import("./analytics-loader");
const { ReferralCapture, applyReferralLinks, readReferralCookie, stripReferralLinks } = await import("./referral-capture");

const labels = {
  banner: { title: "Cookies", body: "We use cookies.", acceptAll: "Accept all", rejectAll: "Reject all", choose: "Choose", noticeLink: "Notice" },
  dialog: {
    title: "Cookie settings",
    close: "Close",
    save: "Save",
    acceptAll: "Accept all",
    rejectAll: "Reject all",
    noticeLink: "Notice",
    necessary: { title: "Necessary", body: "Always on." },
    analytics: { title: "Analytics", body: "Statistics." },
    marketing: { title: "Marketing", body: "Ads." },
  },
};
const KEY = "3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const consentCookie = (a: boolean, m: boolean) => encodeConsentCookie({ k: KEY, v: 1, a, m, t: Math.floor(Date.now() / 1000) });

type Win = Parameters<typeof initGtag>[0];
const resetWindow = () => {
  const w = window as unknown as Record<string, unknown>;
  for (const k of ["gtag", "dataLayer", "fbq", "_fbq", "__beamGtagConfigured", "__beamMarketing"]) delete w[k];
};
function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.trim().split("=")[0];
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

// jsdom keeps `Secure` cookies off an http origin; the capture's cookie writes are recorded instead.
let written: string[] = [];
const cookieDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
beforeEach(() => {
  clearCookies();
  resetWindow();
  written = [];
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => cookieDescriptor.get!.call(document),
    set: (v: string) => {
      written.push(v);
      cookieDescriptor.set!.call(document, v.replace(/; Secure$/, ""));
    },
  });
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 200 }))));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (document as unknown as Record<string, unknown>).cookie;
  window.history.replaceState(null, "", "/");
});

function renderSite(cookie: string | null, opts: { search?: string; body?: React.ReactNode } = {}) {
  window.history.replaceState(null, "", `/nl/actie${opts.search ?? ""}`);
  if (cookie) document.cookie = `beam_consent=${cookie}; Path=/`;
  return render(
    <ConsentProvider locale="nl-BE" bannerVersion={1} latestMaterialOrdinal={null} initialCookie={cookie} cookieNoticeHref={null} labels={labels}>
      {opts.body ?? null}
      <AnalyticsLoader nonce="nonce-p9" gaMeasurementId="G-TEST1234" googleAdsId="AW-1234567" metaPixelId="1234567890" />
      <ReferralCapture />
    </ConsentProvider>,
  );
}

describe("marketing tags (R3)", () => {
  it("load nothing for marketing without marketing consent", () => {
    renderSite(consentCookie(true, false));
    expect(screen.queryByTestId("beam-meta-pixel")).toBeNull();
    expect(screen.getByTestId("beam-gtag").getAttribute("data-src")).toContain("id=G-TEST1234");
    expect((window as unknown as { fbq?: unknown }).fbq).toBeUndefined();
    const queue = ((window as unknown as Win).dataLayer as IArguments[]).map((a) => Array.from(a as ArrayLike<unknown>));
    expect(queue.some((c) => c[0] === "config" && c[1] === "AW-1234567")).toBe(false);
    expect(queue.some((c) => c[0] === "consent" && (c[2] as Record<string, string>).ad_storage === "granted")).toBe(false);
  });

  it("load nothing at all before any choice", () => {
    renderSite(null);
    for (const id of ["beam-gtag", "beam-meta-pixel", "beam-vercel-insights"]) expect(screen.queryByTestId(id)).toBeNull();
  });

  it("load the Google Ads tag and the Meta Pixel with the nonce after marketing consent", () => {
    renderSite(consentCookie(false, true));
    expect(screen.queryByTestId("beam-vercel-insights")).toBeNull();
    expect(screen.getByTestId("beam-gtag").getAttribute("data-src")).toBe("https://www.googletagmanager.com/gtag/js?id=AW-1234567");
    expect(screen.getByTestId("beam-gtag").getAttribute("data-nonce")).toBe("nonce-p9");
    expect(screen.getByTestId("beam-meta-pixel").getAttribute("data-src")).toBe("https://connect.facebook.net/en_US/fbevents.js");
    expect(screen.getByTestId("beam-meta-pixel").getAttribute("data-nonce")).toBe("nonce-p9");
    const win = window as unknown as Win;
    const queue = (win.dataLayer as IArguments[]).map((a) => Array.from(a as ArrayLike<unknown>));
    expect(queue[0]).toEqual(["consent", "default", { analytics_storage: "denied", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }]);
    expect(queue).toContainEqual(["consent", "update", { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted" }]);
    expect(queue).toContainEqual(["config", "AW-1234567"]);
    expect(win.fbq!.queue).toEqual([["init", "1234567890"], ["track", "PageView"]]);
  });

  it("reports a completed form as a conversion", () => {
    renderSite(consentCookie(true, true));
    act(() => void window.dispatchEvent(new CustomEvent("beam-form:completed", { detail: { slug: "contact", kind: "lead", locale: "nl-BE", endingKind: "success" } })));
    const win = window as unknown as Win;
    const queue = (win.dataLayer as IArguments[]).map((a) => Array.from(a as ArrayLike<unknown>));
    expect(queue).toContainEqual(["event", "conversion", { send_to: "AW-1234567" }]);
    expect(win.fbq!.queue).toContainEqual(["track", "Lead", {}]);
  });

  it("ignores invalid ids", () => {
    window.history.replaceState(null, "", "/nl/actie");
    render(
      <ConsentProvider locale="nl-BE" bannerVersion={1} latestMaterialOrdinal={null} initialCookie={consentCookie(false, true)} cookieNoticeHref={null} labels={labels}>
        <AnalyticsLoader nonce="n" gaMeasurementId={null} googleAdsId="G-NOTADS" metaPixelId="pixel" />
      </ConsentProvider>,
    );
    expect(screen.queryByTestId("beam-gtag")).toBeNull();
    expect(screen.queryByTestId("beam-meta-pixel")).toBeNull();
  });

  it("helpers: GA config after an Ads-only start, revoke denies the ad signals, purchase value in euros", () => {
    const win = {} as Win;
    initMarketingTags(win, { googleAdsId: "AW-1234567", metaPixelId: "1234567890" });
    initGtag(win, "G-ABCD1234");
    initMarketingTags(win, { googleAdsId: "AW-1234567", metaPixelId: "1234567890" });
    const calls = () => (win.dataLayer as IArguments[]).map((a) => Array.from(a as ArrayLike<unknown>));
    expect(calls().filter((c) => c[0] === "config")).toEqual([["config", "AW-1234567"], ["config", "G-ABCD1234"]]);
    expect(calls()).toContainEqual(["consent", "update", { analytics_storage: "granted" }]);
    trackMarketingConversion("purchase", { valueCents: 4500 }, win);
    expect(calls()).toContainEqual(["event", "conversion", { send_to: "AW-1234567", value: 45, currency: "EUR" }]);
    expect(win.fbq!.queue).toContainEqual(["track", "Purchase", { value: 45, currency: "EUR" }]);
    revokeMarketingTags(win);
    expect(calls().at(-1)).toEqual(["consent", "update", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }]);
    expect(win.fbq!.queue).toContainEqual(["consent", "revoke"]);
    const before = calls().length;
    trackMarketingConversion("lead", {}, win);
    expect(calls().length).toBe(before);
  });
});

const links = (
  <nav>
    <a href="/nl/account/sign-in">Sign in</a>
    <a href="/nl/checkout?sku=DAY&amp;from=%2Fnl%2Factie">Buy</a>
    <a href="/nl/f/contact">Form</a>
    <a href="/nl/prijzen">Prices</a>
    <a href="https://example.com/nl/checkout">Elsewhere</a>
  </nav>
);
const hrefOf = (name: string) => screen.getByText(name).getAttribute("href");

describe("referral capture (rule 63)", () => {
  it("without marketing consent: no beam_ref cookie, the code only on portal, checkout and form links", () => {
    renderSite(consentCookie(true, false), { search: "?ref=ABCD2345", body: links });
    expect(written.some((c) => c.startsWith("beam_ref="))).toBe(false);
    expect(readReferralCookie()).toBeNull();
    expect(hrefOf("Sign in")).toBe("/nl/account/sign-in?ref=ABCD2345");
    expect(hrefOf("Buy")).toBe("/nl/checkout?sku=DAY&from=%2Fnl%2Factie&ref=ABCD2345");
    expect(hrefOf("Form")).toBe("/nl/f/contact?ref=ABCD2345");
    expect(hrefOf("Prices")).toBe("/nl/prijzen");
    expect(hrefOf("Elsewhere")).toBe("https://example.com/nl/checkout");
  });

  it("before any choice the code also stays off the cookie", () => {
    renderSite(null, { search: "?ref=ABCD2345", body: links });
    expect(written.some((c) => c.startsWith("beam_ref="))).toBe(false);
    expect(hrefOf("Sign in")).toBe("/nl/account/sign-in?ref=ABCD2345");
  });

  it("with marketing consent: stores the code for 30 days and leaves the links alone", () => {
    renderSite(consentCookie(false, true), { search: "?ref=abcd2345", body: links });
    expect(written).toContain("beam_ref=ABCD2345; Path=/; Max-Age=2592000; SameSite=Lax; Secure");
    expect(readReferralCookie()).toBe("ABCD2345");
    expect(hrefOf("Sign in")).toBe("/nl/account/sign-in");
  });

  it("keeps the first code while the cookie lives", () => {
    document.cookie = "beam_ref=WXYZ6789; Path=/";
    written = [];
    renderSite(consentCookie(false, true), { search: "?ref=ABCD2345" });
    expect(written.some((c) => c.startsWith("beam_ref="))).toBe(false);
    expect(readReferralCookie()).toBe("WXYZ6789");
  });

  it("ignores malformed codes", () => {
    renderSite(consentCookie(false, true), { search: "?ref=ABCD1234", body: links });
    expect(written.some((c) => c.startsWith("beam_ref="))).toBe(false);
    cleanup();
    renderSite(consentCookie(false, false), { search: "?ref=<x>", body: links });
    expect(hrefOf("Sign in")).toBe("/nl/account/sign-in");
  });

  it("link helpers append and strip only the page view's code", () => {
    const root = document.createElement("div");
    root.innerHTML = '<a href="/fr/checkout">a</a><a href="/fr/checkout?ref=WXYZ6789">b</a><a href="/fr/prix">c</a>';
    applyReferralLinks(root, "ABCD2345", window.location.origin);
    expect(Array.from(root.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["/fr/checkout?ref=ABCD2345", "/fr/checkout?ref=WXYZ6789", "/fr/prix"]);
    stripReferralLinks(root, "ABCD2345", window.location.origin);
    expect(Array.from(root.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["/fr/checkout", "/fr/checkout?ref=WXYZ6789", "/fr/prix"]);
  });
});

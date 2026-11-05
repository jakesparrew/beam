// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeConsentCookie } from "@beam/core/site";

vi.mock("next/script", () => ({
  default: (props: { id?: string; src?: string; nonce?: string }) => <script data-testid={props.id} data-src={props.src} data-nonce={props.nonce} />,
}));

const { ConsentProvider, useConsent, readConsentCookie } = await import("./consent-provider");
const { AnalyticsLoader, gaIdFor, initGtag } = await import("./analytics-loader");
const { UtmCapture, UTM_STORAGE_KEY, readStoredUtm, utmFromSearch } = await import("./utm-capture");

const labels = {
  banner: { title: "Cookies on this website", body: "We use cookies.", acceptAll: "Accept all", rejectAll: "Reject all", choose: "Choose", noticeLink: "Read the cookie notice" },
  dialog: {
    title: "Cookie settings",
    close: "Close",
    save: "Save my choice",
    acceptAll: "Accept all",
    rejectAll: "Reject all",
    noticeLink: "Read the cookie notice",
    necessary: { title: "Necessary", body: "Always on." },
    analytics: { title: "Analytics", body: "Statistics." },
    marketing: { title: "Marketing", body: "Ads." },
  },
};

const KEY = "3f0c1d2e-4b5a-4c6d-8e7f-9a0b1c2d3e4f";
const now = () => Math.floor(Date.now() / 1000);

function clearCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.trim().split("=")[0];
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  }
}

function Probe() {
  const c = useConsent();
  return (
    <div>
      <span data-testid="state">{`${c.analytics}/${c.marketing}`}</span>
      <button type="button" data-cookie-settings>
        Footer cookie settings
      </button>
    </div>
  );
}

function renderSite(initialCookie: string | null, opts: { latestMaterialOrdinal?: number | null } = {}) {
  return render(
    <ConsentProvider locale="nl-BE" bannerVersion={2} latestMaterialOrdinal={opts.latestMaterialOrdinal ?? null} initialCookie={initialCookie} cookieNoticeHref="/nl/cookies" gaMeasurementId="G-TEST1234" labels={labels}>
      <Probe />
      <AnalyticsLoader nonce="nonce-abc" gaMeasurementId="G-TEST1234" />
      <UtmCapture />
    </ConsentProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearCookies();
  window.sessionStorage.clear();
  fetchMock = vi.fn((_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { action: string; choices: { analytics: boolean; marketing: boolean }; bannerVersion: number };
    const analytics = body.action === "accept_all" || (body.action === "custom" && body.choices.analytics);
    const marketing = body.action === "accept_all" || (body.action === "custom" && body.choices.marketing);
    document.cookie = `beam_consent=${encodeConsentCookie({ k: KEY, v: body.bannerVersion, a: analytics, m: marketing, t: now() })}; Path=/`;
    return Promise.resolve(new Response(JSON.stringify({ consentKey: KEY }), { status: 200 }));
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("cookie banner (rules 36-39)", () => {
  it("shows three equally styled choices and loads no analytics before consent", () => {
    const { container } = renderSite(null);
    const region = screen.getByRole("region", { name: "Cookies on this website" });
    const buttons = region.querySelectorAll("button");
    expect([...buttons].map((b) => b.textContent)).toEqual(["Accept all", "Reject all", "Choose"]);
    expect(new Set([...buttons].map((b) => b.className)).size).toBe(1);
    expect(region.querySelector("input")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByTestId("state").textContent).toBe("false/false");
  });

  it("accept all posts the choice, hides the banner and loads both scripts with the nonce", async () => {
    window.history.replaceState(null, "", "/nl/aanbod?utm_source=newsletter&utm_campaign=spring");
    const { container } = renderSite(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/public/cookie-consent");
    // The response body is read: an unread one keeps the request open in the browser.
    expect(((await fetchMock.mock.results[0]!.value) as Response).bodyUsed).toBe(true);
    expect(JSON.parse(init.body)).toEqual({ action: "accept_all", choices: { analytics: true, marketing: true }, bannerVersion: 2, locale: "nl-BE" });
    expect(screen.queryByRole("region", { name: "Cookies on this website" })).toBeNull();
    expect(screen.getByTestId("state").textContent).toBe("true/true");
    const scripts = [...container.querySelectorAll("script")];
    expect(scripts.map((s) => s.getAttribute("data-src"))).toEqual(["/_vercel/insights/script.js", "https://www.googletagmanager.com/gtag/js?id=G-TEST1234"]);
    expect(scripts.every((s) => s.getAttribute("data-nonce") === "nonce-abc")).toBe(true);
    expect(readStoredUtm()).toEqual({ utm: { source: "newsletter", campaign: "spring" }, landingPath: "/nl/aanbod" });
  });

  it("reject all keeps analytics off and stores no UTM", async () => {
    window.history.replaceState(null, "", "/nl?utm_source=ad");
    const { container } = renderSite(null);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reject all" }));
      await Promise.resolve();
    });
    expect(screen.getByTestId("state").textContent).toBe("false/false");
    expect(container.querySelector("script")).toBeNull();
    expect(window.sessionStorage.getItem(UTM_STORAGE_KEY)).toBeNull();
  });

  it("does not show the banner for a valid choice, and shows it again after a material cookie notice", () => {
    const cookie = encodeConsentCookie({ k: KEY, v: 2, a: true, m: false, t: now() });
    renderSite(cookie);
    expect(screen.queryByRole("region", { name: "Cookies on this website" })).toBeNull();
    expect(screen.getByTestId("state").textContent).toBe("true/false");
    cleanup();
    renderSite(cookie, { latestMaterialOrdinal: 3 });
    expect(screen.getByRole("region", { name: "Cookies on this website" })).toBeTruthy();
    expect(screen.getByTestId("state").textContent).toBe("false/false");
  });

  it("the footer's data-cookie-settings button opens the dialog; withdrawing deletes _ga cookies", async () => {
    const value = encodeConsentCookie({ k: KEY, v: 2, a: true, m: false, t: now() });
    document.cookie = `beam_consent=${value}; Path=/`;
    document.cookie = "_ga=GA1.1.123; Path=/";
    document.cookie = "_ga_TEST1234=GS1.1; Path=/";
    expect(readConsentCookie()).toMatchObject({ k: KEY, a: true });
    renderSite(value);
    fireEvent.click(screen.getByRole("button", { name: "Footer cookie settings" }));
    const dialog = document.querySelector("dialog[data-cookie-dialog]")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    const analytics = screen.getByRole<HTMLInputElement>("switch", { name: "Analytics" });
    expect(analytics.checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("switch", { name: "Necessary" }).disabled).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("switch", { name: "Marketing" }).checked).toBe(false);
    fireEvent.click(analytics);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save my choice" }));
      await Promise.resolve();
    });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as { action: string; consentKey: string };
    expect(body).toMatchObject({ action: "withdraw", consentKey: KEY });
    expect(document.cookie).not.toMatch(/(^|; )_ga/);
    expect(screen.getByTestId("state").textContent).toBe("false/false");
    expect((window as unknown as Record<string, unknown>)["ga-disable-G-TEST1234"]).toBe(true);
  });
});

describe("analytics helpers", () => {
  it("loads GA4 only in production with analytics switched on and a valid id", () => {
    expect(gaIdFor({ isProduction: true, analyticsEnabled: true, gaMeasurementId: "G-ABCD1234" })).toBe("G-ABCD1234");
    expect(gaIdFor({ isProduction: false, analyticsEnabled: true, gaMeasurementId: "G-ABCD1234" })).toBeNull();
    expect(gaIdFor({ isProduction: true, analyticsEnabled: false, gaMeasurementId: "G-ABCD1234" })).toBeNull();
    expect(gaIdFor({ isProduction: true, analyticsEnabled: true, gaMeasurementId: "UA-1234" })).toBeNull();
  });

  it("initialises Consent Mode v2 with only analytics storage granted", () => {
    const win = {} as Parameters<typeof initGtag>[0];
    initGtag(win, "G-ABCD1234");
    const queue = (win.dataLayer as IArguments[]).map((a): unknown[] => Array.from(a as ArrayLike<unknown>));
    expect(queue[0]).toEqual(["consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" }]);
    expect(queue[2]).toEqual(["config", "G-ABCD1234"]);
  });

  it("reads only utm_* values of at most 200 characters", () => {
    expect(utmFromSearch(`?utm_source=a&utm_medium=b&utm_term=${"x".repeat(201)}&other=1`)).toEqual({ source: "a", medium: "b" });
  });
});

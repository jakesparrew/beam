// @vitest-environment jsdom
/** forms-P4: the embed script (forms spec section 5 "Embed script"). */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { embedScript, EMBED_FORWARDED_PARAMS } from "./embed-script";

const BEAM = "https://app.example.com";

let frame: HTMLIFrameElement;
beforeAll(() => {
  window.history.pushState({}, "", "/landing/page?utm_source=facebook&utm_medium=paid_social&utm_campaign=spring&l=abc12345&src=event&private=secret");
  document.body.innerHTML = '<div data-beam-form="recovery-check" data-locale="fr" data-title="Bilan"></div><div data-beam-form="Bad Slug!"></div>';
  // The served script runs as a classic script on the host page; the test runs the same text.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  (new Function(embedScript(`${BEAM}/`)) as () => void)();
  frame = document.querySelector("iframe")!;
});

const post = (origin: string, data: unknown) => window.dispatchEvent(new MessageEvent("message", { origin, data }));

describe("embed.js", () => {
  it("stays under 4 KB", () => {
    expect(new TextEncoder().encode(embedScript(BEAM)).byteLength).toBeLessThan(4096);
  });

  it("creates one lazy iframe per valid div whose src carries the parent's UTM, l and src", () => {
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    const src = new URL(frame.src);
    expect(`${src.origin}${src.pathname}`).toBe(`${BEAM}/fr/f/recovery-check`);
    expect(src.searchParams.get("embed")).toBe("1");
    expect(src.searchParams.get("embedHost")).toBe(window.location.host);
    expect(src.searchParams.get("ref")).toBe(`${window.location.origin}/landing/page`);
    expect(src.searchParams.get("utm_source")).toBe("facebook");
    expect(src.searchParams.get("utm_medium")).toBe("paid_social");
    expect(src.searchParams.get("utm_campaign")).toBe("spring");
    expect(src.searchParams.get("l")).toBe("abc12345");
    expect(src.searchParams.get("src")).toBe("event");
    expect(src.searchParams.has("private")).toBe(false);
    expect(EMBED_FORWARDED_PARAMS).toContain("utm_content");
    expect(frame.getAttribute("loading")).toBe("lazy");
    expect(frame.title).toBe("Bilan");
  });

  it("ignores messages from other origins", () => {
    const listener = vi.fn();
    window.addEventListener("beam-form:completed", listener);
    post("https://evil.example.com", { type: "beam-form:height", h: 900 });
    post("https://evil.example.com", { type: "beam-form:completed", slug: "x", kind: "lead", locale: "en", endingKind: "thank_you" });
    expect(frame.style.height).toBe("");
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener("beam-form:completed", listener);
  });

  it("resizes on beam-form:height from the BEAM origin", () => {
    post(BEAM, { type: "beam-form:height", h: 812.4 });
    expect(frame.style.height).toBe("812px");
  });

  it("re-dispatches beam-form:completed from the BEAM origin only, with the four detail keys", () => {
    const listener = vi.fn();
    window.addEventListener("beam-form:completed", listener);
    post(BEAM, { type: "beam-form:completed", slug: "recovery-check", kind: "assessment", locale: "fr-BE", endingKind: "result", email: "leak@example.com" });
    expect(listener).toHaveBeenCalledTimes(1);
    const detail = (listener.mock.calls[0]![0] as CustomEvent).detail as Record<string, unknown>;
    expect(detail).toEqual({ slug: "recovery-check", kind: "assessment", locale: "fr-BE", endingKind: "result" });
    window.removeEventListener("beam-form:completed", listener);
  });
});

import { describe, expect, it, vi } from "vitest";
import { MissingMessageError } from "../errors";
import { formatDate, formatDateTime, formatMoney } from "./format";
import { localeFromAcceptLanguage, localeFromSegment } from "./locales";
import { createTranslator, messagesFor, t } from "./t";

const KEY = "platform.shell.recovery_codes_left";

describe("t() with ICU plurals", () => {
  it("nl-BE: one and other", () => {
    expect(t("nl-BE", KEY, { count: 1 })).toBe("Je hebt nog 1 herstelcode.");
    expect(t("nl-BE", KEY, { count: 2 })).toBe("Je hebt nog 2 herstelcodes.");
    expect(t("nl-BE", KEY, { count: 0 })).toBe("Je hebt geen herstelcodes meer.");
  });

  it("fr-BE: 1 is one, 2 is other, and the exact =0 case wins", () => {
    expect(t("fr-BE", KEY, { count: 1 })).toBe("Il vous reste 1 code de récupération.");
    expect(t("fr-BE", KEY, { count: 2 })).toBe("Il vous reste 2 codes de récupération.");
    expect(t("fr-BE", KEY, { count: 0 })).toBe("Il ne vous reste aucun code de récupération.");
  });

  it("fr-BE treats 1.5 as one (French plural rule), nl-BE as other", () => {
    const tr = createTranslator({
      "fr-BE": { x: { x: { n: "{n, plural, one {# heure} other {# heures}}" } } },
      "nl-BE": { x: { x: { n: "{n, plural, one {# uur} other {# uren}}" } } },
    });
    expect(tr("fr-BE", "x.n", { n: 1.5 })).toBe("1,5 heure");
    expect(tr("nl-BE", "x.n", { n: 1.5 })).toBe("1,5 uren");
  });

  it("interpolates params and select", () => {
    expect(t("en", "platform.email.magic_link.preheader", { expiresMinutes: 15 })).toContain("15 minutes");
    expect(t("en", "platform.email.mfa_changed.body", { change: "mfa_reset" })).toMatch(/^Two-step verification was reset/);
  });

  it("throws MissingMessageError in tests and renders ⟦key⟧ in marker mode, reporting once per key", () => {
    expect(() => t("en", "platform.nope.missing")).toThrow(MissingMessageError);
    const onMissing = vi.fn();
    const tr = createTranslator({ en: { platform: { platform: { a: "A" } } } }, { mode: "marker", onMissing });
    expect(tr("en", "platform.a")).toBe("A");
    expect(tr("en", "platform.b")).toBe("⟦platform.b⟧");
    expect(tr("en", "platform.b")).toBe("⟦platform.b⟧");
    expect(tr("nl-BE", "platform.a")).toBe("⟦platform.a⟧");
    expect(onMissing).toHaveBeenCalledTimes(2);
  });

  it("never shows another language", () => {
    const tr = createTranslator({ en: { platform: { platform: { a: "A" } } } }, { mode: "marker" });
    expect(tr("fr-BE", "platform.a")).toBe("⟦platform.a⟧");
  });

  it("messagesFor merges module trees for next-intl", () => {
    const m = messagesFor("en", ["platform"]);
    expect(Object.keys(m)).toEqual(["platform"]);
  });
});

describe("formatters and locale helpers", () => {
  it("formats cents as EUR per locale", () => {
    expect(formatMoney(12345, "nl-BE").replace(/\s/g, " ")).toBe("€ 123,45");
    expect(formatMoney(12345, "fr-BE").replace(/\s/g, " ")).toBe("123,45 €");
    expect(formatMoney(12345, "en")).toBe("€123.45");
    expect(() => formatMoney(1.5, "en")).toThrow(TypeError);
  });

  it("formats dates in Brussels time", () => {
    // 23:30 UTC on 31 Dec is already 1 January in Brussels.
    expect(formatDate(new Date("2026-12-31T23:30:00Z"), "en", "long")).toBe("January 1, 2027");
    expect(formatDate("2026-04-06", "nl-BE", "long")).toBe("6 april 2026");
    expect(formatDateTime(new Date("2026-07-01T07:05:00Z"), "nl-BE", "short")).toContain("09:05");
  });

  it("negotiates locales", () => {
    expect(localeFromSegment("fr")).toBe("fr-BE");
    expect(localeFromSegment("de")).toBeNull();
    expect(localeFromAcceptLanguage("de-DE,fr;q=0.8,en;q=0.5")).toBe("fr-BE");
    expect(localeFromAcceptLanguage("nl-NL")).toBe("nl-BE");
    expect(localeFromAcceptLanguage("de")).toBeNull();
  });
});

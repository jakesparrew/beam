import { describe, expect, it } from "vitest";
import { LOCALES, t } from "@beam/core/i18n";
import { renderEmail } from "../../render";
import type { TemplateDef } from "../define";
import { TEMPLATE_REGISTRY } from "../registry.generated";
import { CHECKIN_QR_CID } from "./booking-confirmed";
import { templates } from "./index";

const base = { title: "Dagsessie", date: "dinsdag 12 januari 2027 om 10:00" };

/** The four waitlist templates of booking-P5 (R59) with fixture props. */
const FIXTURES: Record<string, Record<string, string>> = {
  waitlist_joined: { ...base, url: "https://beam.example.com/nl/account/waitlist" },
  seat_offered: { ...base, expiresAt: "dinsdag 12 januari 2027 om 08:00", url: "https://beam.example.com/api/public/claim/abcDEF123_-abcDEF123_-abcDEF123_-abcDEF1" },
  seat_claimed: { ...base, url: "https://beam.example.com/nl/account/bookings/b1" },
  offer_expired: { ...base, url: "https://beam.example.com/nl/account/book/s1" },
};
const byName = (name: string) => templates.find((tpl) => tpl.name === name) as TemplateDef;

describe("booking templates (booking-P5)", () => {
  it("the four waitlist keys are registered and their slots exist in all three locales", () => {
    for (const name of Object.keys(FIXTURES)) {
      expect(Object.keys(TEMPLATE_REGISTRY)).toContain(`booking.${name}`);
      for (const key of Object.values(byName(name).slots)) {
        expect(key.startsWith(`booking.email.${name}.`)).toBe(true);
        for (const locale of LOCALES) expect(t.has(locale, key), `${locale} ${key}`).toBe(true);
      }
    }
  });

  it("props schemas accept the fixtures; a seat offer needs its expiry and claim link", () => {
    for (const [name, props] of Object.entries(FIXTURES)) expect(byName(name).props.safeParse(props).success, name).toBe(true);
    expect(byName("seat_offered").props.safeParse({ ...base, url: FIXTURES.seat_offered!.url }).success).toBe(false);
    expect(byName("seat_offered").props.safeParse({ ...base, expiresAt: "x" }).success).toBe(false);
  });

  for (const [name, props] of Object.entries(FIXTURES)) {
    it.each(LOCALES)(`${name} renders in %s with the session, the link and (claimed only) the inline QR`, async (locale) => {
      const out = await renderEmail(byName(name), { locale, props });
      expect(out.subject).toContain("Dagsessie");
      expect(out.html).toContain(`lang="${locale}"`);
      expect(out.html).not.toMatch(/⟦/);
      expect(out.text).toContain(props.url);
      expect(out.text.replace(/\s+/g, " ")).toContain(t(locale, `booking.email.${name}.intro`, props).slice(0, 25));
      if (name === "seat_offered") expect(out.text).toContain("08:00");
      if (name === "seat_claimed") expect(out.html).toContain(`src="${CHECKIN_QR_CID}"`);
      else expect(out.html).not.toContain(CHECKIN_QR_CID);
    });
  }
});

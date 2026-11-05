import { describe, expect, it } from "vitest";
import { LOCALES, t } from "@beam/core/i18n";
import { renderEmail } from "../../render";
import type { TemplateDef } from "../define";
import { TEMPLATE_REGISTRY } from "../registry.generated";
import { CHECKIN_QR_CID } from "./booking-confirmed";
import { templates } from "./index";

const props = {
  title: "Lezing",
  date: "dinsdag 12 januari 2027 om 19:30",
  expiresAt: "maandag 11 januari 2027 om 12:00",
  url: "https://beam.example.com/api/public/claim/abcDEF123_-abcDEF123_-abcDEF123_-abcDEF1",
};
const tpl = () => templates.find((x) => x.name === "lead_window_open") as TemplateDef;

describe("booking.lead_window_open (booking-P7, R24)", () => {
  it("is registered and its slots exist in all three locales", () => {
    expect(Object.keys(TEMPLATE_REGISTRY)).toContain("booking.lead_window_open");
    for (const key of Object.values(tpl().slots)) {
      expect(key.startsWith("booking.email.lead_window_open.")).toBe(true);
      for (const locale of LOCALES) expect(t.has(locale, key), `${locale} ${key}`).toBe(true);
    }
  });

  it("needs the expiry and the claim link, like booking.seat_offered", () => {
    expect(tpl().props.safeParse(props).success).toBe(true);
    expect(tpl().props.safeParse({ ...props, url: undefined }).success).toBe(false);
    expect(tpl().props.safeParse({ ...props, expiresAt: undefined }).success).toBe(false);
  });

  it.each(LOCALES)("renders in %s with the session, the expiry and the claim link, without a QR", async (locale) => {
    const out = await renderEmail(tpl(), { locale, props });
    expect(out.subject).toContain("Lezing");
    expect(out.html).toContain(`lang="${locale}"`);
    expect(out.html).not.toMatch(/⟦/);
    expect(out.text).toContain(props.url);
    expect(out.text).toContain("12:00");
    expect(out.html).not.toContain(CHECKIN_QR_CID);
  });
});

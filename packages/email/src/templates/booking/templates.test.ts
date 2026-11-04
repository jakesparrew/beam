import { describe, expect, it } from "vitest";
import { LOCALES, t } from "@beam/core/i18n";
import { renderEmail } from "../../render";
import type { TemplateDef } from "../define";
import { TEMPLATE_REGISTRY } from "../registry.generated";
import { CHECKIN_QR_CID } from "./booking-confirmed";
import { templates } from "./index";

const base = { title: "Dagsessie", date: "dinsdag 12 januari 2027 om 10:00", url: "https://beam.example.com/nl/account/bookings/b1" };

/** Fixture `data` per template, with every variant. */
const FIXTURES: Record<string, Array<{ label: string; props: Record<string, unknown> }>> = {
  booking_confirmed: [
    { label: "default", props: { ...base } },
    { label: "pay at desk", props: { ...base, payAtDesk: true } },
  ],
  guest_invited: [{ label: "default", props: { ...base, ownerFirstName: "Ann" } }],
};

const P3A_KEYS = ["booking.booking_confirmed", "booking.guest_invited"];
const byName = (name: string) => templates.find((tpl) => tpl.name === name) as TemplateDef;

describe("booking templates (booking-P3a)", () => {
  it("are registered under booking.<name> and the file names match", () => {
    const keys = templates.map((tpl) => `booking.${tpl.name}`);
    expect(keys).toEqual(expect.arrayContaining(P3A_KEYS));
    for (const key of P3A_KEYS) expect(Object.keys(TEMPLATE_REGISTRY)).toContain(key);
  });

  it("every slot key exists in the booking catalogue in all three locales", () => {
    for (const name of Object.keys(FIXTURES)) {
      const tpl = byName(name);
      for (const key of Object.values(tpl.slots)) {
        expect(key.startsWith(`booking.email.${name}.`)).toBe(true);
        for (const locale of LOCALES) expect(t.has(locale, key), `${locale} ${key}`).toBe(true);
      }
    }
  });

  it("fixture props pass the props schemas; a guest invitation needs the owner's first name", () => {
    for (const [name, variants] of Object.entries(FIXTURES)) for (const v of variants) expect(byName(name).props.safeParse(v.props).success, `${name} ${v.label}`).toBe(true);
    expect(byName("guest_invited").props.safeParse(base).success).toBe(false);
  });

  for (const [name, variants] of Object.entries(FIXTURES)) {
    for (const variant of variants) {
      describe(`${name} (${variant.label})`, () => {
        it.each(LOCALES)("renders in %s with subject, text and the inline QR (cid:checkin-qr.png)", async (locale) => {
          const out = await renderEmail(byName(name), { locale, props: variant.props });
          expect(out.subject.trim()).not.toBe("");
          expect(out.subject).toContain("Dagsessie");
          expect(out.html).toContain(`lang="${locale}"`);
          expect(out.html).toContain(`src="${CHECKIN_QR_CID}"`);
          expect(out.html).not.toMatch(/⟦/);
          expect(out.text).toContain(variant.props.url as string);
          const intro = t(locale, `booking.email.${name}.intro`, variant.props as Record<string, string>);
          expect(out.text.replace(/\s+/g, " ")).toContain(intro.slice(0, 25));
          const payLine = t(locale, "booking.email.booking_confirmed.pay_at_desk");
          if (variant.props.payAtDesk) expect(out.text).toContain(payLine);
          else if (name === "booking_confirmed") expect(out.text).not.toContain(payLine);
          if (name === "guest_invited") expect(out.text).toContain("Ann");
        });
      });
    }
  }
});

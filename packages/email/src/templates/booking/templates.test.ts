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

const P3B_FIXTURES: Record<string, Array<{ label: string; props: Record<string, unknown>; lines?: string[]; absent?: string[] }>> = {
  booking_rescheduled: [{ label: "default", props: { ...base, oldDate: "zaterdag 9 januari 2027 om 10:00" } }],
  booking_cancelled: [
    { label: "cancelled", props: { ...base, reason: "cancelled" }, absent: ["booking.email.booking_cancelled.payment_expired"] },
    { label: "payment expired", props: { ...base, reason: "payment_expired" }, lines: ["booking.email.booking_cancelled.payment_expired"] },
  ],
  booking_late_cancelled: [{ label: "default", props: { ...base } }],
  session_cancelled: [
    {
      label: "refunded",
      props: { ...base, refunded: true, creditReleased: false },
      lines: ["booking.email.session_cancelled.refunded"],
      absent: ["booking.email.session_cancelled.credit_released"],
    },
    {
      label: "credit released",
      props: { ...base, refunded: false, creditReleased: true },
      lines: ["booking.email.session_cancelled.credit_released"],
      absent: ["booking.email.session_cancelled.refunded"],
    },
  ],
  booking_reminder: [
    { label: "day", props: { ...base, kind: "day" }, lines: ["booking.email.booking_reminder.intro_day"] },
    { label: "night", props: { ...base, kind: "night" }, lines: ["booking.email.booking_reminder.intro_night"] },
  ],
};
const P3B_KEYS = Object.keys(P3B_FIXTURES).map((name) => `booking.${name}`);
/** The templates whose sender passes the check-in QR as an inline attachment (R59). */
const WITH_QR = new Set(["booking_rescheduled", "booking_reminder"]);

describe("booking templates (booking-P3b)", () => {
  it("the five P3b keys are registered and their slots exist in all three locales", () => {
    const keys = templates.map((tpl) => `booking.${tpl.name}`);
    expect(keys).toEqual(expect.arrayContaining(P3B_KEYS));
    for (const key of P3B_KEYS) expect(Object.keys(TEMPLATE_REGISTRY)).toContain(key);
    for (const name of Object.keys(P3B_FIXTURES)) {
      for (const key of Object.values(byName(name).slots)) {
        expect(key.startsWith(`booking.email.${name}.`)).toBe(true);
        for (const locale of LOCALES) expect(t.has(locale, key), `${locale} ${key}`).toBe(true);
      }
    }
  });

  it("props schemas accept the fixtures and refuse missing variant data", () => {
    for (const [name, variants] of Object.entries(P3B_FIXTURES)) for (const v of variants) expect(byName(name).props.safeParse(v.props).success, `${name} ${v.label}`).toBe(true);
    expect(byName("booking_rescheduled").props.safeParse(base).success).toBe(false);
    expect(byName("booking_reminder").props.safeParse(base).success).toBe(false);
    expect(byName("booking_reminder").props.safeParse({ ...base, kind: "event" }).success).toBe(false);
  });

  for (const [name, variants] of Object.entries(P3B_FIXTURES)) {
    for (const variant of variants) {
      describe(`${name} (${variant.label})`, () => {
        it.each(LOCALES)("renders in %s", async (locale) => {
          const out = await renderEmail(byName(name), { locale, props: variant.props });
          const params = variant.props as Record<string, string>;
          // The rescheduled subject names the new time, every other subject the session.
          expect(out.subject).toContain(name === "booking_rescheduled" ? base.date : "Dagsessie");
          expect(out.html).toContain(`lang="${locale}"`);
          expect(out.html).not.toMatch(/⟦/);
          expect(out.text).toContain(variant.props.url as string);
          const text = out.text.replace(/\s+/g, " ");
          for (const key of variant.lines ?? []) expect(text).toContain(t(locale, key, params).slice(0, 25));
          for (const key of variant.absent ?? []) expect(text).not.toContain(t(locale, key, params).slice(0, 25));
          if (WITH_QR.has(name)) expect(out.html).toContain(`src="${CHECKIN_QR_CID}"`);
          else expect(out.html).not.toContain(CHECKIN_QR_CID);
          if (name === "booking_rescheduled") expect(text).toContain("zaterdag 9 januari 2027");
        });
      });
    }
  }
});

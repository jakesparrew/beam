import { describe, expect, it } from "vitest";
import {
  CartItem,
  COMMERCE_SETTINGS_DEFAULTS,
  CommerceSettings,
  PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS,
  PaymentProviderByChannel,
} from "./schemas";

const PRODUCT = "6f0e1d2c-3b4a-4596-8877-665544332211";
const SESSION = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const BOOKING = "2b3c4d5e-6f70-4b8c-9dae-1f2a3b4c5d6e";

describe("CartItem", () => {
  it("accepts a booking-originated session line with one booking id", () => {
    expect(CartItem.parse({ productId: PRODUCT, quantity: 1, sessionId: SESSION, bookingIds: [BOOKING] })).toMatchObject({ quantity: 1 });
  });

  it("refuses a session line with quantity 2 or two booking ids (rule 21)", () => {
    expect(CartItem.safeParse({ productId: PRODUCT, quantity: 2, sessionId: SESSION }).success).toBe(false);
    expect(CartItem.safeParse({ productId: PRODUCT, quantity: 1, sessionId: SESSION, bookingIds: [BOOKING, BOOKING] }).success).toBe(false);
    expect(CartItem.safeParse({ productId: PRODUCT, quantity: 1, bookingIds: [BOOKING] }).success).toBe(false);
  });

  it("bounds quantity, dates and the voucher fields", () => {
    expect(CartItem.safeParse({ productId: PRODUCT, quantity: 51 }).success).toBe(false);
    expect(CartItem.safeParse({ productId: PRODUCT, quantity: 1, startOn: "2026-12-01" }).success).toBe(true);
    expect(CartItem.safeParse({ productId: PRODUCT, quantity: 1, startOn: "1/12/2026" }).success).toBe(false);
    expect(
      CartItem.safeParse({ productId: PRODUCT, quantity: 1, amountCents: 5_000, voucher: { recipientName: "Sam", recipientEmail: "sam@example.com", deliverOn: "2026-12-24" } }).success,
    ).toBe(true);
    expect(CartItem.safeParse({ productId: PRODUCT, quantity: 1, voucher: { recipientName: "Sam", message: "x".repeat(501) } }).success).toBe(false);
  });
});

describe("settings schemas (section 2.4)", () => {
  it("accept their defaults", () => {
    expect(CommerceSettings.parse(COMMERCE_SETTINGS_DEFAULTS)).toEqual(COMMERCE_SETTINGS_DEFAULTS);
    expect(PaymentProviderByChannel.parse(PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS)).toEqual(PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS);
    expect(COMMERCE_SETTINGS_DEFAULTS.order_expiry_minutes).toBe(30);
    expect(COMMERCE_SETTINGS_DEFAULTS.refund_second_permission_above_cents).toBe(50_000);
  });

  it("refuse invalid values", () => {
    expect(CommerceSettings.safeParse({ ...COMMERCE_SETTINGS_DEFAULTS, withdrawal_days: 0 }).success).toBe(false);
    expect(CommerceSettings.safeParse({ ...COMMERCE_SETTINGS_DEFAULTS, receipt_footer: { de: "x" } }).success).toBe(false);
    expect(PaymentProviderByChannel.safeParse({ ...PAYMENT_PROVIDER_BY_CHANNEL_DEFAULTS, pos: "cash" }).success).toBe(false);
  });
});

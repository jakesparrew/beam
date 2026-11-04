import { describe, expect, it } from "vitest";
import {
  CHECKOUT_STATUSES,
  MANDATE_STATUSES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  POS_DAY_STATUSES,
  REDEMPTION_STATUSES,
  REFUND_STATUSES,
  STATUS_SOURCES,
  VOUCHER_STATUSES,
} from "./schemas";
import {
  CHECKOUT_TRANSITIONS,
  INITIAL_STATES,
  MANDATE_TRANSITIONS,
  ORDER_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  POS_DAY_TRANSITIONS,
  REDEMPTION_TRANSITIONS,
  REFUND_TRANSITIONS,
  VOUCHER_TRANSITIONS,
  finalStates,
  nextCheckoutStatus,
  nextMandateStatus,
  nextOrderStatus,
  nextPaymentStatus,
  nextPosDayStatus,
  nextRedemptionStatus,
  nextRefundStatus,
  nextVoucherStatus,
  type TransitionMap,
} from "./state-machine";

/** The pairs of spec section 3.1, written out independently of the maps under test. */
const SPEC = {
  orders: [
    "draft>pending_payment",
    "draft>cancelled",
    "pending_payment>paid",
    "pending_payment>expired",
    "pending_payment>cancelled",
    "expired>paid",
    "paid>partially_refunded",
    "paid>refunded",
    "partially_refunded>refunded",
  ],
  payments: [
    "open>pending",
    "open>authorized",
    "open>paid",
    "open>failed",
    "open>expired",
    "open>cancelled",
    "pending>authorized",
    "pending>paid",
    "pending>failed",
    "pending>expired",
    "pending>cancelled",
    "authorized>paid",
    "authorized>failed",
    "authorized>expired",
    "authorized>cancelled",
    "paid>partially_refunded",
    "paid>refunded",
    "partially_refunded>refunded",
  ],
  refunds: ["pending>sent", "pending>refunded", "pending>failed", "sent>refunded", "sent>failed", "failed>pending"],
  vouchers: ["pending>active", "pending>void", "active>redeemed", "active>expired", "active>void"],
  checkouts: ["started>abandoned", "started>completed", "started>expired", "abandoned>completed", "abandoned>expired"],
  promotion_redemptions: ["reserved>confirmed", "reserved>released", "released>confirmed"],
  mandates: ["pending>valid", "pending>invalid", "valid>invalid", "valid>revoked"],
  pos_day_closes: ["open>closed", "closed>open"],
} as const;

type Machine = {
  name: keyof typeof SPEC;
  states: readonly string[];
  map: TransitionMap<string>;
  next: (from: string, to: string) => string | null;
  finals: string[];
};

const machines: Machine[] = [
  { name: "orders", states: ORDER_STATUSES, map: ORDER_TRANSITIONS, next: nextOrderStatus as Machine["next"], finals: ["cancelled", "refunded"] },
  {
    name: "payments",
    states: PAYMENT_STATUSES,
    map: PAYMENT_TRANSITIONS,
    next: (a, b) => nextPaymentStatus(a as never, b as never, "provider"),
    finals: ["failed", "cancelled", "refunded", "expired"],
  },
  { name: "refunds", states: REFUND_STATUSES, map: REFUND_TRANSITIONS, next: nextRefundStatus as Machine["next"], finals: ["refunded"] },
  {
    name: "vouchers",
    states: VOUCHER_STATUSES,
    map: VOUCHER_TRANSITIONS,
    next: nextVoucherStatus as Machine["next"],
    finals: ["redeemed", "expired", "void"],
  },
  { name: "checkouts", states: CHECKOUT_STATUSES, map: CHECKOUT_TRANSITIONS, next: nextCheckoutStatus as Machine["next"], finals: ["completed", "expired"] },
  {
    name: "promotion_redemptions",
    states: REDEMPTION_STATUSES,
    map: REDEMPTION_TRANSITIONS,
    next: nextRedemptionStatus as Machine["next"],
    finals: ["confirmed"],
  },
  { name: "mandates", states: MANDATE_STATUSES, map: MANDATE_TRANSITIONS, next: nextMandateStatus as Machine["next"], finals: ["invalid", "revoked"] },
  { name: "pos_day_closes", states: POS_DAY_STATUSES, map: POS_DAY_TRANSITIONS, next: nextPosDayStatus as Machine["next"], finals: [] },
];

describe.each(machines)("$name state machine", (m) => {
  const listed = new Set<string>(SPEC[m.name]);

  it("covers exactly the enum's states", () => {
    expect(Object.keys(m.map).sort()).toEqual([...m.states].sort());
  });

  it("accepts every listed transition", () => {
    for (const pair of listed) {
      const [from, to] = pair.split(">") as [string, string];
      expect(m.next(from, to), pair).toBe(to);
    }
  });

  it("refuses every unlisted pair, including same-state pairs", () => {
    for (const from of m.states) {
      for (const to of m.states) {
        if (listed.has(`${from}>${to}`)) continue;
        expect(m.next(from, to), `${from}>${to}`).toBeNull();
      }
    }
  });

  it("has the final states of the spec", () => {
    expect(finalStates(m.map).sort()).toEqual([...m.finals].sort());
  });

  it("has no dead state: every state but the initial one has an incoming transition", () => {
    const initial = INITIAL_STATES[m.name] as readonly string[];
    const reachable = new Set<string>([...initial]);
    for (const targets of Object.values(m.map)) for (const t of targets) reachable.add(t);
    expect(m.states.filter((s) => !reachable.has(s))).toEqual([]);
    const withoutIncoming = m.states.filter((s) => !Object.values(m.map).some((targets) => targets.includes(s)));
    for (const s of withoutIncoming) expect(initial, s).toContain(s);
  });
});

describe("payment local_timeout exception (rule 28)", () => {
  it("lets an expired payment set by a local timeout become paid when the provider reports it", () => {
    expect(nextPaymentStatus("expired", "paid", "provider", "local_timeout")).toBe("paid");
  });

  it("keeps a provider-expired payment final", () => {
    expect(nextPaymentStatus("expired", "paid", "provider", "provider")).toBeNull();
    expect(nextPaymentStatus("expired", "paid", "provider")).toBeNull();
  });

  it("does not let a local source revive an expired payment", () => {
    expect(nextPaymentStatus("expired", "paid", "staff", "local_timeout")).toBeNull();
    expect(nextPaymentStatus("expired", "paid", "local_timeout", "local_timeout")).toBeNull();
  });

  it("allows only the other unlisted expired targets to stay refused", () => {
    for (const to of PAYMENT_STATUSES) {
      if (to === "paid") continue;
      for (const src of STATUS_SOURCES) expect(nextPaymentStatus("expired", to, "provider", src), to).toBeNull();
    }
  });

  it("a local timeout may only expire or cancel a live payment", () => {
    expect(nextPaymentStatus("open", "expired", "local_timeout")).toBe("expired");
    expect(nextPaymentStatus("paid", "expired", "local_timeout")).toBeNull();
    expect(nextPaymentStatus("open", "cancelled", "local_timeout")).toBe("cancelled");
    expect(nextPaymentStatus("open", "paid", "local_timeout")).toBeNull();
  });

  it("staff may settle or cancel a live payment (cash, terminal cancel)", () => {
    expect(nextPaymentStatus("open", "paid", "staff")).toBe("paid");
    expect(nextPaymentStatus("pending", "cancelled", "staff")).toBe("cancelled");
  });

  it("ignores a backwards report", () => {
    expect(nextPaymentStatus("paid", "open", "provider")).toBeNull();
    expect(nextPaymentStatus("authorized", "pending", "provider")).toBeNull();
  });
});

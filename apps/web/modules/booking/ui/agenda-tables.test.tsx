// @vitest-environment jsdom
/**
 * The redesigned desk card, waitlist and attendee tables (owner review, November 2026) still
 * carry the hooks the desk's e2e spec and the actions rely on: the card's section with its
 * booking id and status, `check-in`, `to-pay` and `take-payment`; the waitlist rows grouped by
 * date and session with "Offer seat"; the attendee rows with their booking id and check-in.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("../actions/attendance", () => ({ checkIn: vi.fn(), markNoShow: vi.fn(), revertNoShow: vi.fn(), undoCheckIn: vi.fn(), updateBookingNotes: vi.fn() }));
vi.mock("../actions/waitlist", () => ({ moveWaitlistEntry: vi.fn(), offerSeatManually: vi.fn(), releaseWaitlistEntry: vi.fn(), reviewWaitlistFlag: vi.fn() }));
vi.mock("../actions/bookings", () => ({ addGuest: vi.fn(), cancelBooking: vi.fn(), cancelSession: vi.fn(), rescheduleBooking: vi.fn() }));
const { BookingCard } = await import("./booking-card");
const { WaitlistTable } = await import("./waitlist-table");
const { AttendeeList } = await import("./attendee-list");

afterEach(cleanup);

/** Labels that read as their own key, with `extra` for the nested ones. */
const labelsOf = (extra: Record<string, unknown> = {}) => new Proxy(extra, { get: (t, key) => (key in t ? t[key as string] : String(key)) }) as never;
const text = labelsOf();

describe("desk card", () => {
  it("keeps the e2e hooks on a payable and a checkable card", () => {
    const base = {
      bookingId: "b1",
      personId: "p1",
      name: "Anna Peeters",
      sessionLine: "Friday · 10:00–13:00",
      statusLabel: "Confirmed",
      checkedInLabel: null,
      wrongDayLabel: null,
      termsPending: true,
      health: "missing" as const,
      canOverride: false,
      canUndo: false,
      canMarkNoShow: false,
      canRevertNoShow: false,
      notes: null,
      reception: [],
      cues: [{ icon: "moon", label: "Night" }],
      guests: [],
    };
    const { container, rerender } = render(<BookingCard card={{ ...base, status: "confirmed", toPayLabel: null, orderId: null, canCheckIn: true }} labels={text} canWrite />);
    const section = container.querySelector('section[data-booking-id="b1"]');
    expect(section?.getAttribute("data-status")).toBe("confirmed");
    expect(section?.querySelector('[data-action="check-in"]')).not.toBeNull();
    expect(section?.querySelector('[data-testid="checkin-cues"]')?.textContent).toContain("Night");

    rerender(<BookingCard card={{ ...base, status: "reserved", toPayLabel: "To pay: €45.00", orderId: "o1", canCheckIn: false }} labels={text} canWrite />);
    expect(container.querySelector('[data-testid="to-pay"]')?.textContent).toContain("45.00");
    expect(container.querySelector('[data-action="take-payment"]')?.getAttribute("href")).toBe("/admin/pos?order=o1");
    expect(container.querySelector('[data-action="check-in"]')).toBeNull();
  });
});

describe("waitlist table", () => {
  it("groups by date and session and offers a seat to a waiting entry", () => {
    const row = {
      entryId: "e1",
      sessionId: "s1",
      sessionLabel: "Day · Fri",
      sessionTitle: "Day session",
      sessionDate: "2026-11-27",
      dateLabel: "Friday 27 November",
      timeLabel: "10:00",
      productType: "day" as const,
      personId: "p1",
      personName: "Anna Peeters",
      hasEmail: true,
      queue: "public" as const,
      state: "waiting" as const,
      joinedAt: "2026-11-20T10:00:00Z",
      offerExpiresAt: null,
      isFlagged: false,
      flagReason: null,
      bookingId: null,
    };
    const labels = labelsOf({ queues: { lead: "Lead", customer: "Customer", public: "Public" }, productTypes: { day: "Day", night: "Night", event: "Event", webinar: "Webinar" }, states: { waiting: "Waiting", offered: "Offered", confirmed: "Confirmed", released: "Released", expired: "Expired", withdrawn: "Withdrawn" }, waitingCount: "Waiting: {count}", errors: {} });
    render(<WaitlistTable rows={[row, { ...row, entryId: "e2", state: "confirmed" }]} labels={labels} />);
    expect(screen.getByText("Friday 27 November")).toBeTruthy();
    expect(screen.getByText("Waiting: 1")).toBeTruthy();
    expect(screen.getByTestId("waitlist-row-e1").textContent).toContain("offerSeat");
    expect(screen.getByTestId("waitlist-row-e2").querySelector("button")).toBeNull();
  });
});

describe("attendee list", () => {
  it("shows each booking with its id, status and check-in", () => {
    const row = { bookingId: "b1", version: 1, personId: "p1", name: "Anna Peeters", guestOf: "Bart", paidWith: "Paid", status: "confirmed", statusLabel: "Confirmed", toPay: null, notes: null, hasGuests: false, canCheckIn: true, canUndo: false, canMarkNoShow: false, canRevertNoShow: false, canCancel: false, policy: "" };
    const labels = labelsOf({ columns: text, cancelDialog: text, errors: {} });
    const { container } = render(<AttendeeList rows={[row]} labels={labels} canWrite canOverride={false} />);
    const tr = container.querySelector('tr[data-booking-id="b1"]');
    expect(tr?.getAttribute("data-status")).toBe("confirmed");
    expect(tr?.textContent).toContain("Bart");
    expect(screen.getByRole("button", { name: "checkIn" })).toBeTruthy();
  });
});

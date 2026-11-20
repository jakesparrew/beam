import { describe, expect, it } from "vitest";
import { bucketIndex, bucketStarts, buildActivity, interactionOf } from "./activity";

const now = new Date("2026-11-19T12:00:00Z"); // a Thursday
const DAY = 86_400_000;

describe("bucketStarts", () => {
  it("uses at least eight weeks, Monday first, for a short history", () => {
    const b = bucketStarts(now, new Date(now.getTime() - 10 * DAY));
    expect(b.unit).toBe("week");
    expect(b.starts).toHaveLength(8);
    expect(b.starts.at(-1)).toBe("2026-11-16");
    expect(new Date(`${b.starts[0]}T00:00:00Z`).getUTCDay()).toBe(1);
  });

  it("switches to at most twelve months for a long history", () => {
    const b = bucketStarts(now, new Date("2024-03-05T10:00:00Z"));
    expect(b.unit).toBe("month");
    expect(b.starts).toHaveLength(12);
    expect([b.starts[0], b.starts.at(-1)]).toEqual(["2025-12-01", "2026-11-01"]);
  });
});

describe("bucketIndex", () => {
  it("places a moment in its week, and nothing outside the range", () => {
    const { starts } = bucketStarts(now, null);
    expect(bucketIndex(starts, new Date("2026-11-16T08:00:00Z"), "week")).toBe(starts.length - 1);
    expect(bucketIndex(starts, new Date("2026-11-15T23:30:00Z"), "week")).toBe(starts.length - 1); // Monday 00:30 in Brussels
    expect(bucketIndex(starts, new Date("2026-11-15T22:30:00Z"), "week")).toBe(starts.length - 2); // still Sunday in Brussels
    expect(bucketIndex(starts, new Date("2026-11-30T10:00:00Z"), "week")).toBe(-1);
    expect(bucketIndex(starts, new Date("2025-01-01T10:00:00Z"), "week")).toBe(-1);
  });
});

describe("buildActivity", () => {
  it("counts attended visits per kind, missed visits apart, and fills the heat grid", () => {
    const at = (d: string) => new Date(d);
    const data = buildActivity({
      now,
      visits: [
        { startsAt: at("2026-11-13T08:00:00Z"), kind: "day", status: "attended", isGuest: false }, // Fri 09:00
        { startsAt: at("2026-11-13T20:00:00Z"), kind: "night", status: "attended", isGuest: false }, // Fri 21:00
        { startsAt: at("2026-11-06T08:00:00Z"), kind: "day", status: "no_show", isGuest: false },
        { startsAt: at("2026-11-06T08:00:00Z"), kind: "day", status: "attended", isGuest: true },
        { startsAt: at("2026-11-26T08:00:00Z"), kind: "day", status: "confirmed", isGuest: false },
      ],
      interactions: [
        { at: at("2026-11-13T10:00:00Z"), kind: "emails" },
        { at: at("2026-11-17T10:00:00Z"), kind: "chat" },
      ],
    });
    const last = data.buckets.length - 1;
    expect(data.visits.day[last - 1]).toBe(1);
    expect(data.visits.night[last - 1]).toBe(1);
    expect(data.visits.missed[last - 2]).toBe(1);
    expect(data.totals).toEqual({ visits: 2, missed: 1, interactions: 2 });
    expect(data.interactions.chat[last]).toBe(1);
    expect(data.heat[4]).toEqual([1, 0, 1]);
  });

  it("maps timeline kinds to interaction series and ignores bookkeeping", () => {
    expect(["booking.confirmed", "email.sent", "order.paid", "inbox.message_received", "webinar.registered", "credits.consumed", "invoice.issued"].map(interactionOf)).toEqual([
      "bookings",
      "emails",
      "purchases",
      "chat",
      "events",
      null,
      null,
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { clampSegment, effectiveDurationSec, factsReached, mergeIntervals } from "./watch";

const seg = (fromSec: number, toSec: number) => ({ fromSec, toSec });

describe("mergeIntervals (rule 26)", () => {
  it("is zero for no segments", () => {
    expect(mergeIntervals([])).toEqual({ watchedSec: 0, maxPositionSec: 0 });
  });

  it("adds disjoint segments", () => {
    expect(mergeIntervals([seg(0, 15), seg(30, 45)])).toEqual({ watchedSec: 30, maxPositionSec: 45 });
  });

  it("merges overlapping segments", () => {
    expect(mergeIntervals([seg(0, 20), seg(10, 30)])).toEqual({ watchedSec: 30, maxPositionSec: 30 });
  });

  it("merges touching segments into one", () => {
    expect(mergeIntervals([seg(0, 15), seg(15, 30), seg(30, 45)])).toEqual({ watchedSec: 45, maxPositionSec: 45 });
  });

  it("counts a nested segment once", () => {
    expect(mergeIntervals([seg(0, 30), seg(5, 10), seg(10, 20)])).toEqual({ watchedSec: 30, maxPositionSec: 30 });
  });

  it("counts two tabs watching the same seconds once (edge case 2)", () => {
    const tab1 = [seg(0, 15), seg(15, 30), seg(30, 45)];
    const tab2 = [seg(2, 17), seg(17, 32), seg(32, 47)];
    expect(mergeIntervals([...tab1, ...tab2])).toEqual({ watchedSec: 47, maxPositionSec: 47 });
  });

  it("does not depend on input order", () => {
    const segs = [seg(100, 115), seg(0, 15), seg(10, 25), seg(115, 130), seg(60, 70)];
    const shuffled = [segs[3]!, segs[1]!, segs[4]!, segs[0]!, segs[2]!];
    expect(mergeIntervals(shuffled)).toEqual(mergeIntervals(segs));
    expect(mergeIntervals(segs)).toEqual({ watchedSec: 25 + 10 + 30, maxPositionSec: 130 });
  });

  it("ignores empty and inverted segments", () => {
    expect(mergeIntervals([seg(10, 10), seg(20, 5), seg(0, 3)])).toEqual({ watchedSec: 3, maxPositionSec: 3 });
  });
});

describe("factsReached (rule 27)", () => {
  const base = { maxPositionSec: 0, durationSec: 3600, attendedMinSec: 300 };

  it("15m at 900 s, not at 899 s", () => {
    expect(factsReached({ ...base, watchedSec: 899 })).not.toContain("15m");
    expect(factsReached({ ...base, watchedSec: 900 })).toContain("15m");
  });

  it("30m at 1800 s, not at 1799 s", () => {
    expect(factsReached({ ...base, watchedSec: 1799 })).not.toContain("30m");
    expect(factsReached({ ...base, watchedSec: 1800 })).toContain("30m");
  });

  it("attended at attended_min_sec", () => {
    expect(factsReached({ ...base, watchedSec: 299 })).toEqual([]);
    expect(factsReached({ ...base, watchedSec: 300 })).toEqual(["attended"]);
    expect(factsReached({ ...base, watchedSec: 600, attendedMinSec: 900 })).toEqual([]);
  });

  it("50pct at half of an odd duration (rounded up in seconds)", () => {
    const odd = { ...base, durationSec: 3601 };
    expect(factsReached({ ...odd, watchedSec: 1800 })).not.toContain("50pct");
    expect(factsReached({ ...odd, watchedSec: 1801 })).toContain("50pct");
    expect(factsReached({ ...base, durationSec: 3600, watchedSec: 1800 })).toContain("50pct");
  });

  it("end when the furthest position reaches duration - 60", () => {
    expect(factsReached({ ...base, watchedSec: 60, maxPositionSec: 3539 })).not.toContain("end");
    expect(factsReached({ ...base, watchedSec: 60, maxPositionSec: 3540 })).toEqual(["end"]);
  });

  it("returns every fact in order for a full watch", () => {
    expect(factsReached({ ...base, watchedSec: 3600, maxPositionSec: 3600 })).toEqual(["attended", "15m", "30m", "50pct", "end"]);
  });

  it("a zero duration reaches neither 50pct nor end", () => {
    expect(factsReached({ ...base, durationSec: 0, watchedSec: 10, maxPositionSec: 10 })).toEqual([]);
  });

  it("uses the planned duration while the real one is unknown", () => {
    expect(effectiveDurationSec({ durationSec: null, plannedDurationMinutes: 45 })).toBe(2700);
    expect(effectiveDurationSec({ durationSec: 2701, plannedDurationMinutes: 45 })).toBe(2701);
  });
});

describe("clampSegment (rule 24, edge cases 1, 3, 4)", () => {
  const start = new Date("2026-11-20T19:00:00Z");
  const at = (sec: number) => new Date(start.getTime() + sec * 1000);

  it("live positions come from the server clock; client values are ignored", () => {
    const out = clampSegment({ mode: "live", clientFrom: 9000, clientTo: 9999, now: at(1215), liveStartedAt: start, lastHeartbeatAt: at(1200), durationSec: 3600 });
    expect(out).toEqual({ fromSec: 1200, toSec: 1215 });
  });

  it("live spans are at most 15 s, and shorter when the previous heartbeat was closer", () => {
    expect(clampSegment({ mode: "live", clientFrom: 0, clientTo: 0, now: at(600), liveStartedAt: start, lastHeartbeatAt: at(300), durationSec: 3600 })).toEqual({ fromSec: 585, toSec: 600 });
    expect(clampSegment({ mode: "live", clientFrom: 0, clientTo: 0, now: at(612), liveStartedAt: start, lastHeartbeatAt: at(600), durationSec: 3600 })).toEqual({ fromSec: 600, toSec: 612 });
  });

  it("live without a previous heartbeat uses 15 s, never below 0", () => {
    expect(clampSegment({ mode: "live", clientFrom: 0, clientTo: 0, now: at(8), liveStartedAt: start, durationSec: 3600 })).toEqual({ fromSec: 0, toSec: 8 });
  });

  it("live writes nothing before the start or without live_started_at", () => {
    expect(clampSegment({ mode: "live", clientFrom: 0, clientTo: 10, now: at(-5), liveStartedAt: start, durationSec: 3600 })).toBeNull();
    expect(clampSegment({ mode: "live", clientFrom: 0, clientTo: 10, now: at(30), liveStartedAt: null, durationSec: 3600 })).toBeNull();
  });

  it("replay spans are capped by elapsed time + 5 s and by 30 s, keeping the current position", () => {
    const now = at(100);
    expect(clampSegment({ mode: "replay", clientFrom: 0, clientTo: 3600, now, lastHeartbeatAt: at(85), durationSec: 3600 })).toEqual({ fromSec: 3580, toSec: 3600 });
    expect(clampSegment({ mode: "replay", clientFrom: 100, clientTo: 200, now, lastHeartbeatAt: at(0), durationSec: 3600 })).toEqual({ fromSec: 170, toSec: 200 });
    expect(clampSegment({ mode: "on_demand", clientFrom: 100, clientTo: 110, now, lastHeartbeatAt: at(85), durationSec: 3600 })).toEqual({ fromSec: 100, toSec: 110 });
  });

  it("replay positions are clamped to [0, duration]", () => {
    expect(clampSegment({ mode: "replay", clientFrom: -20, clientTo: 10, now: at(15), lastHeartbeatAt: at(0), durationSec: 600 })).toEqual({ fromSec: 0, toSec: 10 });
    expect(clampSegment({ mode: "replay", clientFrom: 590, clientTo: 700, now: at(15), lastHeartbeatAt: at(0), durationSec: 600 })).toEqual({ fromSec: 590, toSec: 600 });
  });

  it("a network gap is not back-filled (edge case 4)", () => {
    expect(clampSegment({ mode: "replay", clientFrom: 0, clientTo: 300, now: at(400), lastHeartbeatAt: at(0), durationSec: 3600 })).toEqual({ fromSec: 270, toSec: 300 });
  });

  it("an empty or inverted replay span writes nothing", () => {
    expect(clampSegment({ mode: "replay", clientFrom: 50, clientTo: 50, now: at(15), lastHeartbeatAt: at(0), durationSec: 600 })).toBeNull();
    expect(clampSegment({ mode: "replay", clientFrom: 60, clientTo: 50, now: at(15), lastHeartbeatAt: at(0), durationSec: 600 })).toBeNull();
    expect(clampSegment({ mode: "replay", clientFrom: Number.NaN, clientTo: 50, now: at(15), durationSec: 600 })).toBeNull();
  });
});

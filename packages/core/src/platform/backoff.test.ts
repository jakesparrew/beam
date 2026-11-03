import { describe, expect, it } from "vitest";
import { BACKOFF_SECONDS, nextRunAt } from "./backoff";

const now = new Date("2026-11-03T12:00:00Z");
const delaySeconds = (attempt: number, r: number) => ((nextRunAt(attempt, now, () => r)?.getTime() ?? Number.NaN) - now.getTime()) / 1000;

describe("nextRunAt (PL-26)", () => {
  it("uses 60/300/900/3600/21600 seconds after attempts 1 to 5 without jitter", () => {
    expect(BACKOFF_SECONDS).toEqual([60, 300, 900, 3600, 21600]);
    expect([1, 2, 3, 4, 5].map((a) => delaySeconds(a, 0))).toEqual([60, 300, 900, 3600, 21600]);
  });

  it("adds at most 20 % jitter", () => {
    expect([1, 2, 3, 4, 5].map((a) => delaySeconds(a, 0.999999))).toEqual(
      [60, 300, 900, 3600, 21600].map((s) => Math.round(s * 1000 * (1 + 0.2 * 0.999999)) / 1000),
    );
    expect(delaySeconds(1, 0.5)).toBe(66);
  });

  it("stays inside the jitter bounds for many random values", () => {
    for (let i = 0; i < 500; i++) {
      const attempt = (i % 5) + 1;
      const base = BACKOFF_SECONDS[attempt - 1]!;
      const d = delaySeconds(attempt, Math.random());
      expect(d).toBeGreaterThanOrEqual(base);
      expect(d).toBeLessThanOrEqual(base * 1.2);
    }
  });

  it("clamps a random source outside [0, 1)", () => {
    expect(delaySeconds(1, -3)).toBe(60);
    expect(delaySeconds(1, 7)).toBe(72);
  });

  it("returns null when the failed attempt was the last one (dead)", () => {
    expect(nextRunAt(6, now, () => 0)).toBeNull();
    expect(nextRunAt(3, now, () => 0, 3)).toBeNull();
    expect(nextRunAt(7, now, () => 0, 10)?.getTime()).toBe(now.getTime() + 21_600_000);
  });

  it("rejects a non-positive attempt", () => {
    expect(() => nextRunAt(0, now)).toThrow(RangeError);
  });
});

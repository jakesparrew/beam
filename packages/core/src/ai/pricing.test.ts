import { describe, expect, it } from "vitest";
import { PermanentError } from "../errors";
import { costCents, DEFAULT_AI_PRICING, pricingFor, roundCents4 } from "./pricing";

const opus = DEFAULT_AI_PRICING["claude-opus-5-5"];
const haiku = DEFAULT_AI_PRICING["claude-haiku-5-5"];

describe("costCents (PL-57)", () => {
  it("uses the seeded prices: Opus 400/2000, Haiku 10/50 cents per million tokens", () => {
    expect(opus).toMatchObject({ in_cents_per_mtok: 400, out_cents_per_mtok: 2000 });
    expect(haiku).toMatchObject({ in_cents_per_mtok: 10, out_cents_per_mtok: 50 });
  });

  it("one million input tokens on Opus cost 400 cents, one million output tokens 2000", () => {
    expect(costCents({ inputTokens: 1_000_000, outputTokens: 0 }, opus)).toBe(400);
    expect(costCents({ inputTokens: 0, outputTokens: 1_000_000 }, opus)).toBe(2000);
  });

  it("a typical Opus draft: 12,000 in, 1,500 out, 8,000 cache reads", () => {
    // (12000*400 + 1500*2000 + 8000*20) / 1e6 = 4.8 + 3 + 0.16 = 7.96
    expect(costCents({ inputTokens: 12_000, outputTokens: 1_500, cacheReadTokens: 8_000 }, opus)).toBe(7.96);
  });

  it("a Haiku classification costs a fraction of a cent, kept to 4 decimals", () => {
    // (1234*10 + 56*50) / 1e6 = 0.01514
    expect(costCents({ inputTokens: 1_234, outputTokens: 56 }, haiku)).toBe(0.0151);
    expect(costCents({ inputTokens: 1, outputTokens: 0 }, haiku)).toBe(0);
  });

  it("zero usage costs nothing; cache reads are optional", () => {
    expect(costCents({ inputTokens: 0, outputTokens: 0 }, opus)).toBe(0);
    expect(costCents({ inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0 }, opus)).toBe(0.4);
  });

  it("Message Batches cost half (R4)", () => {
    expect(costCents({ inputTokens: 12_000, outputTokens: 1_500, cacheReadTokens: 8_000 }, opus, { batch: true })).toBe(3.98);
  });

  it("refuses negative or fractional token counts", () => {
    expect(() => costCents({ inputTokens: -1, outputTokens: 0 }, opus)).toThrow(RangeError);
    expect(() => costCents({ inputTokens: 1.5, outputTokens: 0 }, opus)).toThrow(RangeError);
  });

  it("pricingFor reads settings and fails permanently for an unknown model", () => {
    expect(pricingFor("claude-haiku-5-5")).toBe(haiku);
    const custom = { "claude-opus-5-5": { in_cents_per_mtok: 1, out_cents_per_mtok: 2, cache_read_cents_per_mtok: 0 } };
    expect(pricingFor("claude-opus-5-5", custom).out_cents_per_mtok).toBe(2);
    expect(() => pricingFor("gpt-9", custom)).toThrow(PermanentError);
  });

  it("roundCents4 avoids binary noise", () => {
    expect(roundCents4(0.1 + 0.2)).toBe(0.3);
    expect(roundCents4(1.00005)).toBe(1.0001);
  });
});

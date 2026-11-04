/** forms-P3: abuse limits (rules R2 and R3). */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbHandle } from "@beam/db";
import { formSubmissions, persons } from "@beam/db/schema";
import { createTestDb } from "@beam/db/testing";
import { eq, RateLimitedError } from "@/lib/ctx";
import { resetRuntime } from "@/lib/testing";
import { createForm, later, lead, publicCtx, setupEnv } from "../forms-p3.fixtures";
import { isBotSubmission, limitResultLink, limitStart, limitSubmit, MIN_FILL_SECONDS } from "./rate-limit";
import { completeSubmission, startSubmission } from "./submissions";
import { signSubmissionId } from "./tokens";

let h: DbHandle;
beforeAll(async () => {
  setupEnv();
  h = await createTestDb();
});
afterAll(async () => {
  resetRuntime();
  await h.close();
});

const T0 = new Date("2026-11-04T09:00:00Z");

async function hits(fn: () => Promise<void>, n: number): Promise<number> {
  let ok = 0;
  for (let i = 0; i < n; i++) {
    try {
      await fn();
      ok++;
    } catch (e) {
      expect(e).toBeInstanceOf(RateLimitedError);
      expect((e as RateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
    }
  }
  return ok;
}

describe("R2 thresholds through rateLimit", () => {
  it("start: 30 per form per IP per hour", async () => {
    const formId = randomUUID();
    expect(await hits(() => limitStart(h.db, formId, "iphash-a", T0), 31)).toBe(30);
    expect(await hits(() => limitStart(h.db, formId, "iphash-b", T0), 1)).toBe(1);
    expect(await hits(() => limitStart(h.db, formId, "iphash-a", later(T0, 3600)), 1)).toBe(1);
  });

  it("submit: 5 completions per form per email per hour (case-insensitive email)", async () => {
    const formId = randomUUID();
    expect(await hits(() => limitSubmit(h.db, formId, "Same@Example.com", T0), 3)).toBe(3);
    expect(await hits(() => limitSubmit(h.db, formId, "same@example.com", T0), 3)).toBe(2);
  });

  it("result link: 3 per form per email per day", async () => {
    const formId = randomUUID();
    expect(await hits(() => limitResultLink(h.db, formId, "link@example.com", T0), 4)).toBe(3);
  });

  it("startSubmission applies the start limit per IP", async () => {
    const f = await createForm(h.db, lead());
    let refused = 0;
    for (let i = 0; i < 31; i++) {
      const ctx = publicCtx(h.db, T0);
      await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "en", url: "https://app.example.com/en/f/x", ip: "198.51.100.7" }).catch((e: unknown) => {
        expect(e).toBeInstanceOf(RateLimitedError);
        refused++;
      });
    }
    expect(refused).toBe(1);
  });
});

describe("R3 honeypot and minimum fill time", () => {
  it("isBotSubmission", () => {
    expect(isBotSubmission({ honeypot: "", startedAt: T0, now: later(T0, MIN_FILL_SECONDS) })).toBe(false);
    expect(isBotSubmission({ honeypot: "http://spam", startedAt: T0, now: later(T0, 60) })).toBe(true);
    expect(isBotSubmission({ startedAt: T0, now: later(T0, 2) })).toBe(true);
  });

  it("a honeypot hit or a submit under 3 seconds answers a thank-you and writes nothing", async () => {
    const f = await createForm(h.db, lead());
    for (const c of [{ honeypot: "spam", at: later(T0, 60) }, { honeypot: undefined, at: later(T0, 2) }]) {
      const ctx = publicCtx(h.db, T0);
      const s = await startSubmission(ctx.tx, ctx, { slug: f.slug, locale: "en", url: "https://app.example.com/en/f/x", ip: "198.51.100.8" });
      const sub = publicCtx(h.db, c.at);
      const addr = `bot-${randomUUID().slice(0, 6)}@example.com`;
      const r = await completeSubmission(sub.tx, sub, {
        submissionId: s.submissionId,
        proof: { fsid: signSubmissionId(s.submissionId) },
        answers: { email: addr, first_name: "Bot" },
        ip: "198.51.100.8",
        userAgent: "bot",
        honeypot: c.honeypot,
      });
      expect(r).toEqual({ resultUrl: null, redirectUrl: null, endingKey: "thanks", pendingConfirmation: false });
      const [row] = await h.db.select().from(formSubmissions).where(eq(formSubmissions.id, s.submissionId));
      expect(row).toMatchObject({ status: "started", personId: null });
      expect(await h.db.select().from(persons).where(eq(persons.email, addr))).toHaveLength(0);
    }
  });
});

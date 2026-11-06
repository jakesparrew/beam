// @vitest-environment jsdom
/** The checkout return page's poll (commerce spec 5.2): it keeps polling until a final status. */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReturnPoller, type ReturnPollStatus } from "./return-poller";

const labels = { checking: "Checking", paid: "Paid", granted: "Granted", failed: "Failed", pending: "Pending", expired: "Expired", retry: "Retry" };
const open: ReturnPollStatus = { status: "pending_payment", paymentStatus: "open", dueCents: 1000 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const phase = (c: HTMLElement) => c.querySelector("[data-return-phase]")?.getAttribute("data-return-phase");
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

describe("ReturnPoller", () => {
  it("keeps polling after a failed poll and an unchanged status, then shows paid", async () => {
    const answers = [
      () => Promise.reject(new Error("network")),
      () => Promise.resolve({ ok: false as const, error: { code: "rate_limited", message: "slow down" } }),
      () => Promise.resolve({ ok: true as const, data: open }),
      () => Promise.resolve({ ok: true as const, data: open }),
      () => Promise.resolve({ ok: true as const, data: { ...open, status: "paid", paymentStatus: "paid" } }),
    ];
    const poll = vi.fn(() => (answers.shift() ?? answers[answers.length - 1]!)());
    const { container } = render(<ReturnPoller initial={open} retryAction={null} poll={poll} labels={labels} intervalMs={2000} maxMs={30_000} />);
    expect(phase(container)).toBe("checking");
    for (let i = 0; i < 5; i++) await advance(2000);
    expect(poll).toHaveBeenCalledTimes(5);
    expect(phase(container)).toBe("paid");
    await advance(10_000);
    expect(poll).toHaveBeenCalledTimes(5);
  });

  it("stops at maxMs and shows pending", async () => {
    const poll = vi.fn(() => Promise.resolve({ ok: true as const, data: open }));
    const { container } = render(<ReturnPoller initial={open} retryAction={null} poll={poll} labels={labels} intervalMs={2000} maxMs={6000} />);
    for (let i = 0; i < 5; i++) await advance(2000);
    expect(phase(container)).toBe("pending");
    expect(poll.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

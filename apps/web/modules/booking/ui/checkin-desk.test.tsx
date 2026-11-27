// @vitest-environment jsdom
/** The desk's one-click buttons (owner review, November 2026): one `checkIn` per booking in order, stopping at the first refusal. */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
const checkIn = vi.fn<(input: { bookingId: string }) => Promise<unknown>>();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }), usePathname: () => "/admin/bookings/checkin", useSearchParams: () => new URLSearchParams() }));
vi.mock("../actions/attendance", () => ({ checkIn: (input: { bookingId: string }) => checkIn(input) }));
const { CheckInAllButton, CheckInButton } = await import("./checkin-desk");

const errors = { outside_window: "Outside the window", internal: "Something went wrong" };

afterEach(() => {
  cleanup();
  refresh.mockClear();
  checkIn.mockReset();
});

describe("check-in buttons", () => {
  it("checks every booking in order and refreshes once", async () => {
    checkIn.mockResolvedValue({ ok: true });
    render(<CheckInAllButton bookingIds={["a", "b", "c"]} label="Check in all" errors={errors} />);
    fireEvent.click(screen.getByRole("button", { name: /Check in all/ }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(checkIn.mock.calls.map((c) => c[0].bookingId)).toEqual(["a", "b", "c"]);
  });

  it("stops at the first refusal and shows its text", async () => {
    checkIn.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: { code: "conflict", message: "outside_window" } });
    render(<CheckInAllButton bookingIds={["a", "b", "c"]} label="Check in all" errors={errors} />);
    fireEvent.click(screen.getByRole("button", { name: /Check in all/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Outside the window"));
    expect(checkIn.mock.calls.map((c) => c[0].bookingId)).toEqual(["a", "b"]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("checks one row in", async () => {
    checkIn.mockResolvedValue({ ok: true });
    render(<CheckInButton bookingId="x" label="Check in" errors={errors} />);
    fireEvent.click(screen.getByRole("button", { name: /Check in/ }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(checkIn).toHaveBeenCalledWith({ bookingId: "x" });
  });
});

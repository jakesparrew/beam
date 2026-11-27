// @vitest-environment jsdom
/** Owner review section 10: admin list filters apply on change (selects) or after a typing pause, with no Apply button. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const { AutoFilter } = await import("./auto-filter");

beforeEach(() => {
  vi.useFakeTimers();
  push.mockClear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  return render(
    <>
      <AutoFilter />
      <form method="get" action="/admin/bookings" data-auto-filter="">
        <input type="hidden" name="personId" value="p1" />
        <select name="status" defaultValue="">
          <option value="">All</option>
          <option value="confirmed">Confirmed</option>
        </select>
        <input type="search" name="q" defaultValue="" />
      </form>
      <form method="get" action="/admin/other">
        <select name="x" defaultValue="a">
          <option value="a">A</option>
          <option value="b">B</option>
        </select>
      </form>
    </>,
  );
}

describe("AutoFilter", () => {
  it("applies a select at once and a search after the pause, keeping the other fields", async () => {
    const { container } = setup();
    fireEvent.change(container.querySelector("select[name=status]")!, { target: { value: "confirmed" } });
    expect(push).toHaveBeenLastCalledWith("/admin/bookings?personId=p1&status=confirmed&q=", { scroll: false });

    const q = container.querySelector("input[name=q]")!;
    fireEvent.input(q, { target: { value: "an" } });
    fireEvent.input(q, { target: { value: "ann" } });
    expect(push).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(push).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenLastCalledWith("/admin/bookings?personId=p1&status=confirmed&q=ann", { scroll: false });
  });

  it("applies on Enter and leaves forms without data-auto-filter alone", () => {
    const { container } = setup();
    fireEvent.keyDown(container.querySelector("input[name=q]")!, { key: "Enter" });
    expect(push).toHaveBeenCalledTimes(1);
    fireEvent.change(container.querySelector("select[name=x]")!, { target: { value: "b" } });
    expect(push).toHaveBeenCalledTimes(1);
  });

  it("focuses the super search on / (not while typing) and closes popovers on Escape or a click outside", () => {
    const { container } = render(
      <>
        <AutoFilter />
        <form method="get" action="/admin/bookings" data-auto-filter="">
          <input type="search" name="q" data-super-search="" />
          <details data-popover="" open>
            <summary>Filters</summary>
            <select name="source" />
          </details>
        </form>
        <textarea name="note" />
      </>,
    );
    const q = container.querySelector<HTMLInputElement>("input[name=q]")!;
    const details = container.querySelector("details")!;
    fireEvent.keyDown(container.querySelector("textarea")!, { key: "/" });
    expect(document.activeElement).not.toBe(q);
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(q);

    fireEvent.pointerDown(container.querySelector("select")!);
    expect(details.open).toBe(true);
    fireEvent.pointerDown(document.body);
    expect(details.open).toBe(false);
    details.open = true;
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(details.open).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});

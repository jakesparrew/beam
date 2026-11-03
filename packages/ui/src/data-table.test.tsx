import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { cursorHref, DataTable, type DataTableColumn } from "./data-table";
import { EmptyState } from "./empty-state";

afterEach(cleanup);

type Job = { id: string; kind: string; status: string };

const columns: DataTableColumn<Job>[] = [
  { key: "kind", header: "Kind", cell: (r) => r.kind },
  { key: "status", header: "Status", cell: (r) => r.status },
];

const labels = {
  pagination: "Pagination",
  previous: "Previous",
  next: "Next",
  applyFilters: "Apply",
  filters: "Filters",
};

const rows: Job[] = [
  { id: "j1", kind: "email.send", status: "dead" },
  { id: "j2", kind: "notify.slack", status: "dead" },
];

describe("DataTable", () => {
  it("renders the empty state when there are no rows", () => {
    render(
      <DataTable
        columns={columns}
        rows={[]}
        labels={labels}
        emptyState={<EmptyState title="No dead jobs. Everything ran." />}
      />,
    );
    expect(
      screen.getByText("No dead jobs. Everything ran."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Pagination" }),
    ).not.toBeInTheDocument();
  });

  it("renders rows, headers and row links", () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        labels={labels}
        emptyState={<EmptyState title="Nothing" />}
        onRowHref={(r) => `/admin/system/jobs/${r.id}`}
      />,
    );
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Kind", "Status"]);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("link", { name: "email.send" })).toHaveAttribute(
      "href",
      "/admin/system/jobs/j1",
    );
  });

  it("renders cursor links that keep the other search params", () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        labels={labels}
        emptyState={null}
        nextCursor="c-next"
        prevCursor="c-prev"
        searchParams={{ status: "dead", cursor: "c-now" }}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(within(nav).getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "?status=dead&cursor=c-next",
    );
    expect(within(nav).getByRole("link", { name: "Previous" })).toHaveAttribute(
      "href",
      "?status=dead&cursor=c-prev",
    );
  });

  it("shows a disabled, unfocusable control when there is no previous page", () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        labels={labels}
        emptyState={null}
        nextCursor="n1"
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Pagination" });
    expect(
      within(nav).queryByRole("link", { name: "Previous" }),
    ).not.toBeInTheDocument();
    expect(
      within(nav).getByText("Previous").closest("[aria-disabled]"),
    ).toHaveAttribute("aria-disabled", "true");
    expect(within(nav).getByRole("link", { name: "Next" })).toHaveAttribute(
      "href",
      "?cursor=n1",
    );
  });

  it("pagination is reachable by Tab (PL-90)", async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        labels={labels}
        emptyState={null}
        nextCursor="n1"
        prevCursor="p1"
        onRowHref={(r) => `/jobs/${r.id}`}
      />,
    );
    await user.tab();
    expect(screen.getByRole("link", { name: "email.send" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "notify.slack" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Previous" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Next" })).toHaveFocus();
  });

  it("renders filters as a labelled GET form with current values", () => {
    render(
      <DataTable
        columns={columns}
        rows={rows}
        labels={labels}
        emptyState={null}
        searchParams={new URLSearchParams("status=dead&lane=fast&cursor=x")}
        filters={[
          {
            kind: "select",
            key: "status",
            label: "Status",
            allLabel: "All statuses",
            options: [
              { value: "dead", label: "Dead" },
              { value: "pending", label: "Pending" },
            ],
          },
          { kind: "search", key: "q", label: "Search" },
        ]}
      />,
    );
    const form = screen.getByRole("search", { name: "Filters" });
    expect(form).toHaveAttribute("method", "get");
    expect(screen.getByLabelText("Status")).toHaveValue("dead");
    expect(screen.getByLabelText("Search")).toHaveValue("");
    // Non-filter params survive a submit; the cursor resets.
    const hidden = form.querySelectorAll('input[type="hidden"]');
    expect([...hidden].map((i) => (i as HTMLInputElement).name)).toEqual([
      "lane",
    ]);
  });

  it("cursorHref replaces only the cursor parameter", () => {
    expect(cursorHref(undefined, "cursor", "a")).toBe("?cursor=a");
    expect(
      cursorHref({ q: "x y", tag: ["a", "b"], cursor: "z" }, "cursor", "b"),
    ).toBe("?q=x+y&tag=a&tag=b&cursor=b");
  });
});

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Combobox, filterOptions, type ComboboxOption } from "./combobox";

afterEach(cleanup);

const options: ComboboxOption[] = Array.from({ length: 20 }, (_, i) => ({ value: `v${i}`, label: i === 13 ? "Séance de nuit" : `Product ${i}` }));
const labels = { placeholder: "Choose a product", search: "Search", noMatch: "Nothing found", more: "{count} more: type to search" };

describe("filterOptions", () => {
  it("shows the first entries without a query and every accent-insensitive match with one", () => {
    expect(filterOptions(options, "", 8).map((o) => o.value)).toEqual(["v0", "v1", "v2", "v3", "v4", "v5", "v6", "v7"]);
    expect(filterOptions(options, "seance", 8).map((o) => o.value)).toEqual(["v13"]);
    expect(filterOptions(options, "product 1", 8)).toHaveLength(10);
  });
});

describe("Combobox", () => {
  it("lists a short selection, searches the rest by keyboard and writes the hidden input", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = render(
      <form>
        <Combobox name="product" options={options} labels={labels} onChange={onChange} />
      </form>,
    );
    await user.click(screen.getByRole("button", { name: "Choose a product" }));
    expect(screen.getAllByRole("option")).toHaveLength(8);
    expect(screen.getByText("12 more: type to search")).toBeInTheDocument();
    const search = screen.getByRole("combobox", { name: "Search" });
    expect(search).toHaveFocus();
    await user.type(search, "nuit");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith("v13", options[13]);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Séance de nuit" })).toHaveFocus();
    expect(container.querySelector('input[name="product"]')).toHaveValue("v13");
  });

  it("moves with the arrow keys and closes on Escape without choosing", async () => {
    const user = userEvent.setup();
    render(<Combobox options={options} labels={labels} defaultValue="v2" />);
    await user.click(screen.getByRole("button", { name: "Product 2" }));
    await user.keyboard("{ArrowDown}{ArrowDown}");
    const search = screen.getByRole("combobox");
    expect(search.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[2]!.id);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Product 2" })).toBeInTheDocument();
  });

  it("asks onSearch from two characters and keeps the label of a remote pick", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn((q: string) => Promise.resolve([{ value: "p1", label: `Ann (${q})`, hint: "ann@example.com" }]));
    render(<Combobox options={[]} labels={labels} onSearch={onSearch} />);
    await user.click(screen.getByRole("button", { name: "Choose a product" }));
    await user.type(screen.getByRole("combobox"), "an");
    await waitFor(() => expect(screen.getByRole("option", { name: /Ann \(an\)/ })).toBeInTheDocument());
    await user.click(screen.getByRole("option", { name: /Ann/ }));
    expect(screen.getByRole("button", { name: "Ann (an)" })).toBeInTheDocument();
    expect(onSearch).toHaveBeenCalledWith("an");
  });
});

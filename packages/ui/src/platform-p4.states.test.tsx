import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cn } from "./cn";
import { Button } from "./components/button";
import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";
import * as ui from "./index";
import { LocaleUnavailable } from "./locale-unavailable";

afterEach(cleanup);

describe("shared states", () => {
  it("EmptyState shows the named sentence and the next action", () => {
    render(
      <EmptyState
        title="No staff users yet. Invite the first one."
        action={<Button>Invite</Button>}
        icon={<svg data-testid="icon" />}
      />,
    );
    expect(
      screen.getByText("No staff users yet. Invite the first one."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invite" })).toBeInTheDocument();
    expect(screen.getByTestId("icon").parentElement).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("ErrorState shows the request id and calls retry", async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(
      <ErrorState
        title="Something went wrong"
        requestId="req_01HZX"
        requestIdLabel="Request id"
        retry={{ label: "Try again", onClick: reset }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.getByText("req_01HZX")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("ErrorState renders a retry link when given an href", () => {
    render(
      <ErrorState title="Oops" retry={{ label: "Reload", href: "/admin" }} />,
    );
    expect(screen.getByRole("link", { name: "Reload" })).toHaveAttribute(
      "href",
      "/admin",
    );
  });

  it("LocaleUnavailable links the live locales with hreflang and lang", () => {
    render(
      <LocaleUnavailable
        title="This page is not available in English"
        alternativesLabel="Available languages"
        alternatives={[
          { locale: "nl-BE", label: "Nederlands", href: "/nl/yoga" },
          { locale: "fr-BE", label: "Français", href: "/fr/yoga" },
        ]}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "not available in English",
    );
    const fr = screen.getByRole("link", { name: "Français" });
    expect(fr).toHaveAttribute("hreflang", "fr-BE");
    expect(fr).toHaveAttribute("lang", "fr-BE");
    expect(
      screen.getByRole("list", { name: "Available languages" }),
    ).toBeInTheDocument();
  });
});

describe("base components", () => {
  it("Button defaults to type=button so it never submits a form by accident", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "type",
      "button",
    );
  });

  it("cn merges conflicting Tailwind classes", () => {
    expect(cn("px-2 text-sm", false, "px-4")).toBe("text-sm px-4");
  });

  it("the barrel exports the composites and the shadcn set", () => {
    for (const name of [
      "DataTable",
      "LocalizedInput",
      "FormField",
      "AdminShell",
      "PortalShell",
      "EmptyState",
      "ErrorState",
      "LocaleUnavailable",
      "ReportProblemDialog",
      "Button",
      "Dialog",
      "Sheet",
      "DropdownMenu",
      "Select",
      "Tabs",
      "Table",
      "Toaster",
      "Command",
      "Pagination",
      "Breadcrumb",
    ]) {
      expect(ui, name).toHaveProperty(name);
    }
  });
});

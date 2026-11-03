import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminShell,
  type AdminShellLabels,
  type NavSection,
} from "./admin-shell";
import { PortalShell } from "./portal-shell";

afterEach(cleanup);

// jsdom lacks ResizeObserver (Radix) and matchMedia (the sonner Toaster's system theme).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  writable: true,
  value: (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList,
});

const labels: AdminShellLabels = {
  skipToContent: "Skip to content",
  navigation: "Main navigation",
  openNavigation: "Open menu",
  closeNavigation: "Close menu",
  userMenu: "Account menu",
  reportProblem: "Report a problem",
  signOut: "Sign out",
  tester: "Tester",
  brand: "BEAM",
};

const nav: NavSection[] = [
  {
    key: "crm",
    label: "Customers",
    items: [
      {
        key: "crm.persons",
        href: "/admin/persons",
        label: "Persons",
        icon: "users",
      },
    ],
  },
  {
    key: "platform",
    label: "System",
    items: [
      {
        key: "platform.jobs",
        href: "/admin/system/jobs",
        label: "Jobs",
        icon: "server",
      },
      {
        key: "platform.unknown_icon",
        href: "/admin/system/audit",
        label: "Audit",
        icon: "no-such-icon",
      },
    ],
  },
];

function renderShell(
  overrides: Partial<Parameters<typeof AdminShell>[0]> = {},
) {
  const onReportProblem = vi.fn();
  render(
    <AdminShell
      nav={nav}
      user={{ name: "Ann Peeters", email: "ann@demo.beam.be", isTester: true }}
      userMenu={{ onReportProblem, signOutHref: "/admin/logout" }}
      labels={labels}
      currentPath="/admin/system/jobs/123"
      {...overrides}
    >
      <h1>Dashboard</h1>
    </AdminShell>,
  );
  return { onReportProblem };
}

describe("AdminShell", () => {
  it("renders only the items it is given (filtering happens in the app)", () => {
    renderShell({ nav: [nav[1]!] });
    const sidebar = screen.getByRole("navigation", { name: "Main navigation" });
    const links = within(sidebar).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("data-nav-key"))).toEqual([
      "platform.jobs",
      "platform.unknown_icon",
    ]);
    expect(within(sidebar).queryByText("Persons")).not.toBeInTheDocument();
    expect(
      within(sidebar).getByRole("heading", { name: "System" }),
    ).toBeInTheDocument();
  });

  it("marks the active entry", () => {
    renderShell();
    expect(screen.getByRole("link", { name: "Jobs" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Persons" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("has a skip link as the first tab stop and nav/main/banner landmarks (PL-90)", async () => {
    const user = userEvent.setup();
    renderShell();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    const main = screen.getByRole("main");
    expect(skip).toHaveAttribute("href", `#${main.id}`);
    expect(main).toContainElement(
      screen.getByRole("heading", { name: "Dashboard" }),
    );
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    await user.tab();
    expect(skip).toHaveFocus();
  });

  it("shows the banner and the tester badge", () => {
    renderShell({
      banner: <div role="status">Go-live: 9 of 13 items confirmed</div>,
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Go-live: 9 of 13 items confirmed",
    );
    expect(screen.getByText("Tester")).toBeInTheDocument();
  });

  it("opens the user menu with Report a problem and Sign out", async () => {
    const user = userEvent.setup();
    const { onReportProblem } = renderShell();
    await user.click(screen.getByRole("button", { name: "Account menu" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("ann@demo.beam.be")).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: "Sign out" }),
    ).toHaveAttribute("href", "/admin/logout");
    await user.click(
      within(menu).getByRole("menuitem", { name: "Report a problem" }),
    );
    expect(onReportProblem).toHaveBeenCalledTimes(1);
  });

  it("opens the mobile navigation in a sheet", async () => {
    const user = userEvent.setup();
    renderShell();
    await user.click(screen.getByRole("button", { name: "Open menu" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("link", { name: "Persons" }),
    ).toHaveAttribute("href", "/admin/persons");
  });
});

describe("PortalShell", () => {
  const localeSwitch = {
    label: "Language",
    options: [
      { locale: "nl-BE", label: "NL", href: "/nl/account" },
      { locale: "fr-BE", label: "FR", href: "/fr/account" },
      { locale: "en", label: "EN", href: "/en/account" },
    ],
  };

  it("renders the customer nav, locale switch, skip link and main landmark", () => {
    render(
      <PortalShell
        nav={[
          {
            key: "crm.profile",
            href: "/fr/account/profile",
            label: "Profil",
            icon: "user",
          },
        ]}
        locale="fr-BE"
        localeSwitch={localeSwitch}
        currentPath="/fr/account/profile"
      >
        <h1>Mon compte</h1>
      </PortalShell>,
    );
    expect(
      screen.getByRole("link", { name: "Aller au contenu" }),
    ).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toContainElement(
      screen.getByRole("heading", { name: "Mon compte" }),
    );
    const navs = screen.getAllByRole("navigation", {
      name: "Navigation du compte",
    });
    expect(navs).toHaveLength(2);
    for (const n of navs) {
      expect(within(n).getByRole("link", { name: "Profil" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
    const switcher = screen.getByRole("list", { name: "Language" });
    expect(within(switcher).getByRole("link", { name: "FR" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(switcher).getByRole("link", { name: "NL" })).toHaveAttribute(
      "hreflang",
      "nl-BE",
    );
  });

  it("uses the labels it is given", () => {
    render(
      <PortalShell
        nav={[]}
        locale="en"
        localeSwitch={localeSwitch}
        labels={{
          skipToContent: "Jump to main",
          navigation: "Portal",
          brand: "BEAM",
        }}
      >
        <p>Hi</p>
      </PortalShell>,
    );
    expect(
      screen.getByRole("link", { name: "Jump to main" }),
    ).toBeInTheDocument();
    expect(screen.getByText("BEAM")).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Portal" }),
    ).toBeInTheDocument();
  });
});

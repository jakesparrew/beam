"use client";

import { LifeBuoyIcon, LogOutIcon, MenuIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cn } from "./cn";
import { Avatar, AvatarFallback } from "./components/avatar";
import { Badge } from "./components/badge";
import { Button } from "./components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/dropdown-menu";
import { NavIcon } from "./components/nav-icon";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./components/sheet";
import { Toaster } from "./components/sonner";

/** One navigation entry; `icon` is a lucide name from a module's `nav.ts` or an element. */
export type NavItem = {
  key: string;
  href: string;
  label: string;
  icon?: string | ReactNode;
};

/** A labelled group of navigation entries (the app filters them by permission). */
export type NavSection = {
  key: string;
  label: string;
  items: NavItem[];
  /** Rendered as a closed `<details>` group that opens when it holds the current page. */
  collapsible?: boolean;
  /**
   * A top-level menu entry: the row links here (with `icon`) and its `items` fold out below it,
   * opened while one of them (or the row itself) holds the current page.
   */
  href?: string;
  icon?: string | ReactNode;
};

export type AdminShellUser = {
  name: string;
  email?: string;
  /** Role name in the user's locale, shown in the user menu. */
  roleLabel?: string;
  /** Shows the tester badge (`users.is_tester`). */
  isTester?: boolean;
};

export type AdminShellLabels = {
  /** Skip link, for example "Skip to content". */
  skipToContent: string;
  /** Accessible name of the sidebar navigation, for example "Main navigation". */
  navigation: string;
  /** Mobile menu button, for example "Open menu". */
  openNavigation: string;
  /** Mobile menu close button, for example "Close menu". */
  closeNavigation: string;
  /** Accessible name of the user menu button, for example "Account menu". */
  userMenu: string;
  reportProblem: string;
  signOut: string;
  /** Tester badge text, for example "Tester". */
  tester?: string;
  /** Product name in the header, for example "BEAM". */
  brand: string;
};

export type AdminShellProps = {
  nav: NavSection[];
  user: AdminShellUser;
  /** Go-live or environment banner above the header. */
  banner?: ReactNode;
  userMenu: { onReportProblem: () => void; signOutHref: string };
  labels: AdminShellLabels;
  /** Current pathname, to mark the active entry with `aria-current="page"`. */
  currentPath?: string;
  /** Extra header content (for example a global search). */
  headerSlot?: ReactNode;
  /** Logo image for the sidebar (light artwork, it sits on the dark sidebar); the brand text otherwise. */
  logoSrc?: string;
  children: ReactNode;
};

const MAIN_ID = "main-content";

function isActive(href: string, currentPath?: string): boolean {
  if (!currentPath) return false;
  return currentPath === href || currentPath.startsWith(`${href}/`);
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** A top-level entry with its sub-pages folding out underneath (sections with an `href`). */
function NavGroup({
  section,
  currentPath,
  onNavigate,
}: {
  section: NavSection & { href: string };
  currentPath?: string;
  onNavigate?: () => void;
}) {
  const children = section.items.filter((i) => i.href !== section.href);
  const holdsActive =
    isActive(section.href, currentPath) || children.some((i) => isActive(i.href, currentPath));
  const [open, setOpen] = useState(holdsActive);
  const rowActive = holdsActive;
  return (
    <li data-nav-section={section.key}>
      <div
        className={cn(
          "group/row relative flex items-center rounded-xl transition-colors hover:bg-sidebar-accent",
          rowActive && "bg-sidebar-accent",
        )}
      >
        {rowActive ? (
          <span aria-hidden="true" className="absolute top-2 bottom-2 left-0 w-1 rounded-full bg-sidebar-primary" />
        ) : null}
        <a
          href={section.href}
          data-nav-key={section.key}
          aria-current={isActive(section.href, currentPath) && !children.some((i) => isActive(i.href, currentPath)) ? "page" : undefined}
          onClick={onNavigate}
          className={cn(
            "flex flex-1 items-center gap-3 px-3 py-2.5 text-sm font-medium text-sidebar-foreground transition-colors group-hover/row:text-sidebar-accent-foreground",
            rowActive && "text-sidebar-accent-foreground",
          )}
        >
          <span className={cn("grid size-5 place-items-center", rowActive ? "text-sidebar-primary" : "opacity-80")}>
            <NavIcon icon={section.icon} />
          </span>
          <span>{section.label}</span>
        </a>
        {children.length ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={section.label}
            onClick={() => setOpen((v) => !v)}
            className="mr-1 grid size-8 place-items-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-sidebar-ring"
          >
            <span aria-hidden="true" className={cn("text-xs transition-transform", open && "rotate-90")}>
              ›
            </span>
          </button>
        ) : null}
      </div>
      {children.length && open ? (
        <ul className="mt-1 mb-2 ml-[1.375rem] flex flex-col gap-0.5 border-l border-sidebar-border pl-3">
          {children.map((item) => {
            const active = isActive(item.href, currentPath);
            return (
              <li key={item.key}>
                <a
                  href={item.href}
                  data-nav-key={item.key}
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  className={cn(
                    "block rounded-lg px-2.5 py-1.5 text-[0.8125rem] text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    active && "font-medium text-sidebar-primary",
                  )}
                >
                  {item.label}
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}

function NavList({
  nav,
  currentPath,
  label,
  onNavigate,
}: {
  nav: NavSection[];
  currentPath?: string;
  label: string;
  onNavigate?: () => void;
}) {
  if (nav.length && nav.every((s) => s.href)) {
    return (
      <nav aria-label={label} className="p-3">
        <ul className="flex flex-col gap-1">
          {nav.map((section) => (
            <NavGroup key={section.key} section={section as NavSection & { href: string }} currentPath={currentPath} onNavigate={onNavigate} />
          ))}
        </ul>
      </nav>
    );
  }
  return (
    <nav aria-label={label} className="flex flex-col gap-6 p-4">
      {nav.map((section) => {
        const heading = (
          <h2 className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {section.label}
          </h2>
        );
        const list = (
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => {
              const active = isActive(item.href, currentPath);
              return (
                <li key={item.key}>
                  <a
                    href={item.href}
                    data-nav-key={item.key}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                      active &&
                        "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                    )}
                  >
                    <NavIcon icon={item.icon} />
                    <span>{item.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        );
        if (section.collapsible) {
          const open = section.items.some((i) => isActive(i.href, currentPath));
          return (
            <details key={section.key} data-nav-section={section.key} open={open} className="group -my-2 flex flex-col gap-1">
              <summary className="flex cursor-pointer list-none items-center justify-between rounded-md py-1 pr-2 hover:bg-sidebar-accent [&::-webkit-details-marker]:hidden">
                {heading}
                <span aria-hidden="true" className="text-xs text-muted-foreground transition-transform group-open:rotate-90">
                  ›
                </span>
              </summary>
              {list}
            </details>
          );
        }
        return (
          <div key={section.key} data-nav-section={section.key} className="flex flex-col gap-1">
            {heading}
            {list}
          </div>
        );
      })}
    </nav>
  );
}

/**
 * The staff back-office chrome: skip link, banner, header with the user menu ("Report a
 * problem", "Sign out", PL-86), sidebar navigation and the `main` landmark (PL-90).
 * It renders exactly the entries it is given; permission filtering happens in the app.
 */
export function AdminShell({
  nav,
  user,
  banner,
  userMenu,
  labels,
  currentPath,
  headerSlot,
  logoSrc,
  children,
}: AdminShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const logo = (
    <a href="/admin" className="flex items-center px-5 py-6">
      {logoSrc ? (
        // eslint-disable-next-line @next/next/no-img-element -- a static brand file
        <img src={logoSrc} alt="" className="h-8 w-auto" />
      ) : null}
      <span className={logoSrc ? "sr-only" : "text-lg font-semibold text-sidebar-accent-foreground"}>{labels.brand}</span>
    </a>
  );

  return (
    <div
      data-slot="admin-shell"
      className="flex min-h-dvh bg-background text-foreground"
    >
      <a
        href={`#${MAIN_ID}`}
        className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {labels.skipToContent}
      </a>
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col overflow-y-auto bg-sidebar text-sidebar-foreground md:flex">
        {logo}
        <NavList
          nav={nav}
          currentPath={currentPath}
          label={labels.navigation}
        />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
      {banner ? <div data-slot="admin-shell-banner" className="px-4 pt-4 md:px-8">{banner}</div> : null}
      <header className="sticky top-0 z-40 flex h-16 items-center gap-3 bg-background/80 px-4 backdrop-blur-md md:px-8">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label={labels.openNavigation}
            >
              <MenuIcon aria-hidden />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            closeLabel={labels.closeNavigation}
            className="overflow-y-auto border-sidebar-border bg-sidebar p-0 text-sidebar-foreground"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{labels.navigation}</SheetTitle>
              <SheetDescription>{labels.brand}</SheetDescription>
            </SheetHeader>
            {logo}
            <NavList
              nav={nav}
              currentPath={currentPath}
              label={labels.navigation}
              onNavigate={() => setMobileOpen(false)}
            />
          </SheetContent>
        </Sheet>
        <span className="font-semibold md:hidden">{labels.brand}</span>
        {user.isTester && labels.tester ? (
          <Badge variant="warning">{labels.tester}</Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-3">
          {headerSlot}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="gap-2 px-2"
                aria-label={labels.userMenu}
              >
                <Avatar className="size-7">
                  <AvatarFallback className="text-xs">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden text-sm sm:inline">{user.name}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="grid gap-0.5">
                <span>{user.name}</span>
                {user.email ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    {user.email}
                  </span>
                ) : null}
                {user.roleLabel ? (
                  <span className="text-xs font-normal text-muted-foreground">
                    {user.roleLabel}
                  </span>
                ) : null}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => userMenu.onReportProblem()}>
                <LifeBuoyIcon aria-hidden />
                {labels.reportProblem}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={userMenu.signOutHref}>
                  <LogOutIcon aria-hidden />
                  {labels.signOut}
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <main
        id={MAIN_ID}
        tabIndex={-1}
        className="min-w-0 flex-1 px-4 pt-2 pb-10 outline-none md:px-8"
      >
        {children}
      </main>
      </div>
      <Toaster />
    </div>
  );
}

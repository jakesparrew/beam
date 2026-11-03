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
export type NavSection = { key: string; label: string; items: NavItem[] };

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
  return (
    <nav aria-label={label} className="flex flex-col gap-6 p-4">
      {nav.map((section) => (
        <div
          key={section.key}
          data-nav-section={section.key}
          className="flex flex-col gap-1"
        >
          <h2 className="px-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {section.label}
          </h2>
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
        </div>
      ))}
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
  children,
}: AdminShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div
      data-slot="admin-shell"
      className="flex min-h-dvh flex-col bg-background text-foreground"
    >
      <a
        href={`#${MAIN_ID}`}
        className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {labels.skipToContent}
      </a>
      {banner ? <div data-slot="admin-shell-banner">{banner}</div> : null}
      <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-background px-4">
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
            className="overflow-y-auto bg-sidebar p-0"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{labels.navigation}</SheetTitle>
              <SheetDescription>{labels.brand}</SheetDescription>
            </SheetHeader>
            <NavList
              nav={nav}
              currentPath={currentPath}
              label={labels.navigation}
              onNavigate={() => setMobileOpen(false)}
            />
          </SheetContent>
        </Sheet>
        <span className="font-semibold">{labels.brand}</span>
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
      <div className="flex flex-1">
        <aside className="hidden w-60 shrink-0 border-r bg-sidebar md:block">
          <NavList
            nav={nav}
            currentPath={currentPath}
            label={labels.navigation}
          />
        </aside>
        <main
          id={MAIN_ID}
          tabIndex={-1}
          className="min-w-0 flex-1 p-4 outline-none md:p-6"
        >
          {children}
        </main>
      </div>
      <Toaster />
    </div>
  );
}

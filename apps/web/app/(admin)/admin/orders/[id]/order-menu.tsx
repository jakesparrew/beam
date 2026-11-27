"use client";

import type { Route } from "next";
import Link from "next/link";
import { Fragment, useState, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@beam/ui";

/** One entry of the "⋯" menu: a link, or a dialog whose body (a server-rendered form) the page passes in. */
export type OrderMenuItem = {
  key: string;
  label: string;
  href?: string;
  dialog?: { title: string; description?: string; body: ReactNode };
  destructive?: boolean;
};

/**
 * The "⋯" menu of `/admin/orders/[id]`: the order's secondary actions. A menu item cannot be a
 * dialog trigger of its own, so this holds which dialog is open; the dialog closes on submit and
 * the server action's redirect brings the result notice.
 */
export function OrderMenu({ label, closeLabel, items }: { label: string; closeLabel: string; items: OrderMenuItem[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const active = items.find((i) => i.key === open)?.dialog;
  const last = items.findIndex((i) => i.destructive);
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger aria-label={label} className="grid size-9 place-items-center rounded-lg border border-border bg-card text-base leading-none font-semibold text-muted-foreground hover:bg-muted hover:text-foreground">
          <span aria-hidden="true">⋯</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56 rounded-lg p-1 text-[0.8125rem]">
          {items.map((i, n) => (
            <Fragment key={i.key}>
              {n === last && n > 0 ? <DropdownMenuSeparator /> : null}
              {i.href ? (
                <DropdownMenuItem asChild>
                  <Link href={i.href as Route}>{i.label}</Link>
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem variant={i.destructive ? "destructive" : "default"} onSelect={() => setOpen(i.key)}>
                  {i.label}
                </DropdownMenuItem>
              )}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={!!active} onOpenChange={(o) => (o ? null : setOpen(null))}>
        {active ? (
          <DialogContent closeLabel={closeLabel}>
            <DialogHeader>
              <DialogTitle>{active.title}</DialogTitle>
              {active.description ? <DialogDescription>{active.description}</DialogDescription> : null}
            </DialogHeader>
            <div onSubmit={() => setOpen(null)}>{active.body}</div>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}

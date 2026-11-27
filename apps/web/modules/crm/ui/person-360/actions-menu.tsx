"use client";
/**
 * The 360 header's "⋯" menu (owner review, November 2026): every secondary action of the
 * customer profile in one quiet menu next to the single primary "Boeken". The page decides which
 * items the actor may see; every string is a prop.
 */
import Link from "next/link";
import { Fragment } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@beam/ui";

export type PersonMenuItem = {
  key: string;
  href: string;
  label: string;
  separated?: boolean;
};

export function PersonActionsMenu({
  label,
  items,
}: {
  label: string;
  items: PersonMenuItem[];
}) {
  if (!items.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        title={label}
        data-testid="person-actions-menu"
        className="grid size-9 place-items-center rounded-lg border border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="size-4"
        >
          <circle cx="5" cy="12" r="1.75" />
          <circle cx="12" cy="12" r="1.75" />
          <circle cx="19" cy="12" r="1.75" />
        </svg>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {items.map((it) => (
          <Fragment key={it.key}>
            {it.separated ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem asChild>
              <Link
                href={it.href as never}
                data-action={it.key}
                className="text-[0.8125rem]"
              >
                {it.label}
              </Link>
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

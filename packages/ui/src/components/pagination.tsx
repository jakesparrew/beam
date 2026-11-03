import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";
import { buttonVariants, type ButtonProps } from "./button";

/** Pagination landmark; the caller passes the accessible `aria-label` (for example "Pagination"). */
export function Pagination({ className, ...props }: ComponentProps<"nav">) {
  return (
    <nav
      data-slot="pagination"
      className={cn("mx-auto flex w-full justify-center", className)}
      {...props}
    />
  );
}

export function PaginationContent({
  className,
  ...props
}: ComponentProps<"ul">) {
  return (
    <ul
      data-slot="pagination-content"
      className={cn("flex flex-row items-center gap-1", className)}
      {...props}
    />
  );
}

export function PaginationItem(props: ComponentProps<"li">) {
  return <li data-slot="pagination-item" {...props} />;
}

export type PaginationLinkProps = { isActive?: boolean } & Pick<
  ButtonProps,
  "size"
> &
  ComponentProps<"a">;

export function PaginationLink({
  className,
  isActive,
  size = "icon",
  ...props
}: PaginationLinkProps) {
  return (
    <a
      aria-current={isActive ? "page" : undefined}
      data-slot="pagination-link"
      data-active={isActive}
      className={cn(
        buttonVariants({ variant: isActive ? "outline" : "ghost", size }),
        className,
      )}
      {...props}
    />
  );
}

/**
 * A disabled pagination control: not a link, not focusable, announced as disabled.
 * Used when there is no previous or next page.
 */
export function PaginationDisabled({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      data-slot="pagination-disabled"
      aria-disabled="true"
      className={cn(
        buttonVariants({ variant: "ghost", size: "default" }),
        "pointer-events-none opacity-50",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function PaginationPrevious({
  className,
  label,
  ...props
}: ComponentProps<"a"> & { label: string }) {
  return (
    <PaginationLink
      data-slot="pagination-previous"
      size="default"
      className={cn("gap-1 px-2.5", className)}
      {...props}
    >
      <ChevronLeftIcon aria-hidden />
      <span>{label}</span>
    </PaginationLink>
  );
}

export function PaginationNext({
  className,
  label,
  ...props
}: ComponentProps<"a"> & { label: string }) {
  return (
    <PaginationLink
      data-slot="pagination-next"
      size="default"
      className={cn("gap-1 px-2.5", className)}
      {...props}
    >
      <span>{label}</span>
      <ChevronRightIcon aria-hidden />
    </PaginationLink>
  );
}

export function PaginationEllipsis({
  className,
  label,
  ...props
}: ComponentProps<"span"> & { label: string }) {
  return (
    <span
      data-slot="pagination-ellipsis"
      className={cn("flex size-9 items-center justify-center", className)}
      {...props}
    >
      <MoreHorizontalIcon className="size-4" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
}

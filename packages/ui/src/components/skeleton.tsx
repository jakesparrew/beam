import type { ComponentProps } from "react";
import { cn } from "../cn";

/** Loading placeholder; `motion-safe` keeps it still under `prefers-reduced-motion`. */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn("rounded-md bg-muted motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}

/** Table skeleton for route `loading.tsx` files of list screens. */
export function TableSkeleton({
  rows = 8,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div
      data-slot="table-skeleton"
      className={cn("flex flex-col gap-2", className)}
      aria-hidden
    >
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-2">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className="h-8 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

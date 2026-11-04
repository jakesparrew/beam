import { Skeleton } from "@beam/ui";

/** Skeleton while one booking loads (booking spec 5). */
export default function Loading() {
  return (
    <div className="grid gap-4" aria-busy="true" data-testid="booking-loading">
      <Skeleton className="h-8 w-2/3" />
      <div className="grid gap-4 md:grid-cols-[1fr_auto]">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="size-48" />
      </div>
      <Skeleton className="h-11 w-48" />
    </div>
  );
}

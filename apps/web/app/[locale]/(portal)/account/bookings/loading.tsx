import { Skeleton } from "@beam/ui";

/** Skeleton while the booking list loads (booking spec 5: every list has a loading state). */
export default function Loading() {
  return (
    <div className="grid gap-4" aria-busy="true" data-testid="bookings-loading">
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

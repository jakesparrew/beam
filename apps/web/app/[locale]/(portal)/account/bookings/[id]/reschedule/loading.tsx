import { Skeleton } from "@beam/ui";

/** Skeleton while the reschedule targets load (booking spec 5). */
export default function Loading() {
  return (
    <div className="grid gap-4" aria-busy="true" data-testid="reschedule-loading">
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

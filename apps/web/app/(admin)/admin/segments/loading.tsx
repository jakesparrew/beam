import { Skeleton } from "@beam/ui";

/** Skeleton of the segment list and the segment builder while they load (crm spec 5.1). */
export default function SegmentsLoading() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full max-w-xl" />
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

import { Skeleton } from "@beam/ui";

/** Skeleton while a POS screen loads (platform spec 5). */
export default function PosLoading() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <Skeleton className="h-8 w-64" />
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

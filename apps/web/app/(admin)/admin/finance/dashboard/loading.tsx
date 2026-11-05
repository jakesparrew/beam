import { Skeleton } from "@beam/ui";

/** Skeleton while the finance dashboard loads (finance spec section 5): header, period selector, tiles and charts. */
export default function FinanceDashboardLoading() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-9 w-full max-w-2xl" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}

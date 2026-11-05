import { Skeleton } from "@beam/ui";

/** Title and widget skeletons while a custom dashboard evaluates its widgets (ops spec 5, R4). */
export default function CustomDashboardLoading() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-36 w-full" />
      </div>
    </div>
  );
}

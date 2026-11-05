import { Skeleton } from "@beam/ui";

/** Filter and table skeletons while the management dashboard loads (ops spec 5). */
export default function ManagementDashboardLoading() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-9 w-full max-w-xl" />
      <Skeleton className="h-9 w-full max-w-md" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

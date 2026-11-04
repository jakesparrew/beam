import { Skeleton } from "@beam/ui";

/** List skeleton while the report index loads (ops spec 5). */
export default function ReportsLoading() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      {Array.from({ length: 4 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full max-w-xl" />
      ))}
    </div>
  );
}

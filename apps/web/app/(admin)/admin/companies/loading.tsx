import { Skeleton } from "@beam/ui";

/** Table skeleton while the company list loads (crm spec 5.1). */
export default function CompaniesLoading() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full max-w-xl" />
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

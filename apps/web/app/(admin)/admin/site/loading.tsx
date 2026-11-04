import { Skeleton } from "@beam/ui";

/** Skeleton of the website screens while they load (site spec section 5). */
export default function SiteAdminLoading() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-9 w-96" />
      <Skeleton className="h-24 w-full" />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

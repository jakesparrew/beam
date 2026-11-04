import { Skeleton } from "@beam/ui";

/** The skeleton while the customer's packages load (credits spec section 5). */
export default function AccountPackagesLoading() {
  return (
    <div className="grid max-w-4xl gap-4" aria-busy="true">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

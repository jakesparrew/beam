import { Skeleton } from "@beam/ui";

/** The portal shell skeleton while the invoice list or detail loads (finance spec section 5). */
export default function AccountInvoicesLoading() {
  return (
    <div className="grid max-w-4xl gap-4" aria-busy="true">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

import { Skeleton } from "@beam/ui";

/** The skeleton while the customer's membership loads (credits spec section 5). */
export default function AccountMembershipLoading() {
  return (
    <div className="grid max-w-3xl gap-4" aria-busy="true">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-64 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

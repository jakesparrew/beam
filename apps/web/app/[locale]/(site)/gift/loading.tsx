import { Skeleton } from "@beam/ui";

/** Skeleton of the gift voucher page (section 5: loading states are skeletons). */
export default function GiftLoading() {
  return (
    <div className="mx-auto grid w-full max-w-2xl gap-4 px-4 py-10" aria-busy="true">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-12 w-40" />
    </div>
  );
}

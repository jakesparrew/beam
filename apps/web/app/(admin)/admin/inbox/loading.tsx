import { Skeleton } from "@beam/ui";

/** Thread list skeleton while the inbox loads (crm spec 5.1). */
export default function InboxLoading() {
  return (
    <div className="grid gap-4" aria-busy="true">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-10 w-full max-w-2xl" />
      <div className="grid gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    </div>
  );
}

import { Skeleton } from "@beam/ui";

/** Skeleton of the customer profile (crm spec 5.1): avatar header, KPI row, tabs, then the two overview columns. */
export default function Person360Loading() {
  return (
    <div className="grid gap-4" aria-busy="true">
      <Skeleton className="h-4 w-20" />
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <Skeleton className="size-12 rounded-full" />
          <div className="grid gap-2">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-36" />
          </div>
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-8 w-[28rem] max-w-full" />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
        <div className="grid gap-4">
          <Skeleton className="h-56 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}

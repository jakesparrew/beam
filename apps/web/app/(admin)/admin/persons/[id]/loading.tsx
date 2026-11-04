import { Skeleton } from "@beam/ui";

/** Skeleton of the customer 360 layout (crm spec 5.1): header with reception card, KPI strip, panels, timeline. */
export default function Person360Loading() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <div className="grid gap-4 lg:grid-cols-[1fr_minmax(16rem,22rem)]">
        <div className="grid gap-3">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full" />
        </div>
        <Skeleton className="h-40 w-full" />
      </div>
      <Skeleton className="h-20 w-full" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-36 w-full" />
        ))}
      </div>
      <div className="grid gap-2">
        <Skeleton className="h-6 w-32" />
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}

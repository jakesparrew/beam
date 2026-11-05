import { Skeleton } from "@beam/ui";

/** Week card skeletons while the weekly summaries load (ops spec 5). */
export default function WeeklySummaryLoading() {
  return (
    <div className="grid gap-6" aria-busy="true">
      <Skeleton className="h-8 w-56" />
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-40 w-full" />
      ))}
    </div>
  );
}

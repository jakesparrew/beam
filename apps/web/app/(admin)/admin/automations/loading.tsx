import { Skeleton } from "@beam/ui";

/** Skeleton of the automation screens while they load (automation spec 5). */
export default function AutomationsLoading() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-10 w-full max-w-2xl" />
      {Array.from({ length: 8 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

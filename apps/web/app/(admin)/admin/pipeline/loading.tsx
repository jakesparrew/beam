import { Skeleton } from "@beam/ui";

/** Board skeleton while the pipeline loads (crm spec 5.1). */
export default function PipelineLoading() {
  return (
    <div className="grid gap-4" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full max-w-xl" />
      <div className="flex gap-3 overflow-hidden">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="grid w-72 shrink-0 gap-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

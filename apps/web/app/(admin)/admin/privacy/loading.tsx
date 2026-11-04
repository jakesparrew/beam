import { Skeleton } from "@beam/ui";

/** Table skeleton while the privacy requests load (ops spec 5). */
export default function PrivacyLoading() {
  return (
    <div className="grid gap-3" aria-busy="true">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full max-w-xl" />
      {Array.from({ length: 10 }, (_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  );
}

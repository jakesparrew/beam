import { Skeleton } from "@beam/ui";

/** The portal skeleton while the privacy page loads (ops spec 5). */
export default function AccountPrivacyLoading() {
  return (
    <div className="grid max-w-3xl gap-4" aria-busy="true">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-24 w-full" />
      ))}
    </div>
  );
}

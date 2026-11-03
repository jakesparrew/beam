import { Skeleton } from "@beam/ui";

export default function PortalLoading() {
  return (
    <div className="grid gap-4 p-4" aria-busy="true">
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

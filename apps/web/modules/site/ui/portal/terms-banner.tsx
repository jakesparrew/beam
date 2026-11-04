"use client";

/**
 * The non-blocking terms banner of every portal page (site rule 35, edge cases 32 and 33;
 * site-P6), rendered by `PortalSiteChrome` while the customer has not accepted the latest
 * material terms version. "Read the new terms" opens the live terms page; "Accept" calls
 * `acceptCurrentTerms` with the version the banner shows. When newer terms were published in the
 * meantime the action answers `conflict` and the banner asks to reload.
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@beam/ui";
import { acceptCurrentTerms } from "../../actions/portal";

export type TermsBannerLabels = { banner: string; read: string; accept: string; newer: string };

export function TermsBanner({ versionId, readHref, labels }: { versionId: string; readHref: string | null; labels: TermsBannerLabels }) {
  const router = useRouter();
  const [state, setState] = useState<"open" | "accepted" | "conflict" | "error">("open");
  const [pending, startTransition] = useTransition();

  if (state === "accepted") return null;

  const accept = () =>
    startTransition(async () => {
      const res = await acceptCurrentTerms({ versionId });
      if (res.ok) {
        setState("accepted");
        router.refresh();
      } else {
        setState(res.error.code === "conflict" ? "conflict" : "error");
      }
    });

  return (
    <aside aria-label={labels.banner} data-terms-banner data-version-id={versionId} className="border-b bg-muted px-4 py-3 text-sm">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3">
        <p className="flex-1">{labels.banner}</p>
        {readHref ? (
          <a href={readHref} className="font-medium underline underline-offset-4" target="_blank" rel="noopener">
            {labels.read}
          </a>
        ) : null}
        {state === "conflict" ? (
          <p role="status" data-terms-conflict>
            {labels.newer}
          </p>
        ) : (
          <Button type="button" size="sm" onClick={accept} disabled={pending} aria-busy={pending || undefined}>
            {labels.accept}
          </Button>
        )}
      </div>
    </aside>
  );
}

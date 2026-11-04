"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@beam/ui";

/**
 * Error boundary of the public site with a retry button and the request id. Client components
 * have no catalogue, so the texts are platform's `platform.shell.error_*` strings per URL locale
 * (the same approach as the portal boundary).
 */
const TEXT = {
  nl: { title: "Er ging iets mis", body: "Probeer het opnieuw. Blijft het gebeuren, meld het probleem dan met de referentie hieronder.", retry: "Opnieuw proberen", ref: "Referentie" },
  fr: { title: "Une erreur s’est produite", body: "Réessayez. Si le problème persiste, signalez-le avec la référence ci-dessous.", retry: "Réessayer", ref: "Référence" },
  en: { title: "Something went wrong", body: "Try again. If it keeps happening, report the problem with the reference below.", retry: "Try again", ref: "Reference" },
} as const;

export default function SiteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const seg = typeof window === "undefined" ? "nl" : (window.location.pathname.split("/")[1] ?? "nl");
  const text = TEXT[(seg in TEXT ? seg : "nl") as keyof typeof TEXT];
  return (
    <div className="mx-auto max-w-xl px-4 py-16">
      <ErrorState title={text.title} description={text.body} requestId={error.digest ?? null} requestIdLabel={text.ref} retry={{ label: text.retry, onClick: reset }} />
    </div>
  );
}

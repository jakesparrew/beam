"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@beam/ui";

/**
 * "Something went wrong" with the request id and a retry button for the pipeline screens. Client
 * error boundaries have no catalogue access, so the texts follow `<html lang>` (the same three
 * strings as `crm.common.error`, `crm.common.retry` and `crm.common.error_reference`).
 */
const TEXT = {
  "nl-BE": { title: "Er ging iets mis", body: "Probeer het opnieuw. Blijft het gebeuren, meld het probleem met de referentie.", retry: "Opnieuw proberen", ref: "Referentie" },
  "fr-BE": { title: "Une erreur s’est produite", body: "Réessayez. Si le problème persiste, signalez-le avec la référence.", retry: "Réessayer", ref: "Référence" },
  en: { title: "Something went wrong", body: "Try again. If it keeps happening, report the problem with the reference.", retry: "Try again", ref: "Reference" },
} as const;

export default function PipelineError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const lang = typeof document === "undefined" ? "nl-BE" : document.documentElement.lang;
  const text = TEXT[(lang in TEXT ? lang : "nl-BE") as keyof typeof TEXT];
  return <ErrorState title={text.title} description={text.body} requestId={error.digest ?? null} requestIdLabel={text.ref} retry={{ label: text.retry, onClick: reset }} />;
}

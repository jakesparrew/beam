"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@beam/ui";

/**
 * Inline error panel with "Retry" and the request id for the marketing dashboard (ops spec 5). Client
 * error boundaries have no catalogue access, so the texts follow `<html lang>` (the same strings
 * as `ops.common.error_title` and `ops.common.retry`).
 */
const TEXT = {
  "nl-BE": { title: "Deze pagina kon niet laden", body: "Probeer het opnieuw. Blijft het gebeuren, meld het probleem met de referentie.", retry: "Opnieuw proberen", ref: "Referentie" },
  "fr-BE": { title: "Cette page n’a pas pu se charger", body: "Réessayez. Si le problème persiste, signalez-le avec la référence.", retry: "Réessayer", ref: "Référence" },
  en: { title: "This page could not load", body: "Try again. If it keeps happening, report the problem with the reference.", retry: "Try again", ref: "Reference" },
} as const;

export default function MarketingReportError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const lang = typeof document === "undefined" ? "nl-BE" : document.documentElement.lang;
  const text = TEXT[(lang in TEXT ? lang : "nl-BE") as keyof typeof TEXT];
  return <ErrorState title={text.title} description={text.body} requestId={error.digest ?? null} requestIdLabel={text.ref} retry={{ label: text.retry, onClick: reset }} />;
}

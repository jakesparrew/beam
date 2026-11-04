"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@beam/ui";

/**
 * Error boundary of the website screens (site spec section 5): retry button and the request id.
 * Client error boundaries have no catalogue access, so the short texts follow `<html lang>`.
 */
const TEXT = {
  "nl-BE": { title: "De websitepagina kon niet laden", body: "Probeer het opnieuw. Blijft het gebeuren, meld het probleem met de referentie.", retry: "Opnieuw proberen", ref: "Referentie" },
  "fr-BE": { title: "La page du site n’a pas pu être chargée", body: "Réessayez. Si le problème persiste, signalez-le avec la référence.", retry: "Réessayer", ref: "Référence" },
  en: { title: "The website screen could not load", body: "Try again. If it keeps happening, report the problem with the reference.", retry: "Try again", ref: "Reference" },
} as const;

export default function SiteAdminError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const lang = typeof document === "undefined" ? "nl-BE" : document.documentElement.lang;
  const text = TEXT[(lang in TEXT ? lang : "nl-BE") as keyof typeof TEXT];
  return <ErrorState title={text.title} description={text.body} requestId={error.digest ?? null} requestIdLabel={text.ref} retry={{ label: text.retry, onClick: reset }} />;
}

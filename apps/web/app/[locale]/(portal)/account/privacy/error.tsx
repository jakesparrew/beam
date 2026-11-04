"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@beam/ui";

/**
 * Error boundary of the portal privacy page: the localised "Something went wrong, try again"
 * panel with the request id (ops spec 5). Texts per URL locale (client components have no
 * catalogue).
 */
const TEXT = {
  nl: { title: "Er ging iets mis", body: "Je privacygegevens konden niet geladen worden. Probeer het opnieuw.", retry: "Opnieuw proberen", ref: "Referentie" },
  fr: { title: "Une erreur s’est produite", body: "Vos données de confidentialité n’ont pas pu être chargées. Réessayez.", retry: "Réessayer", ref: "Référence" },
  en: { title: "Something went wrong", body: "Your privacy page could not be loaded. Try again.", retry: "Try again", ref: "Reference" },
} as const;

export default function AccountPrivacyError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const seg = typeof window === "undefined" ? "nl" : (window.location.pathname.split("/")[1] ?? "nl");
  const text = TEXT[(seg in TEXT ? seg : "nl") as keyof typeof TEXT];
  return <ErrorState title={text.title} description={text.body} requestId={error.digest ?? null} requestIdLabel={text.ref} retry={{ label: text.retry, onClick: reset }} />;
}

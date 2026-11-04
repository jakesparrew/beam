"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@beam/ui";

/**
 * Error boundary of the portal membership screen: "Something went wrong, try again" with the
 * request id (credits spec section 5). Texts per URL locale: an error boundary receives no
 * locale prop and client components have no catalogue.
 */
const TEXT = {
  nl: { title: "Er ging iets mis", body: "Je lidmaatschap kon niet geladen worden. Probeer het opnieuw.", retry: "Opnieuw proberen", ref: "Referentie" },
  fr: { title: "Une erreur s’est produite", body: "Votre abonnement n’a pas pu être chargé. Réessayez.", retry: "Réessayer", ref: "Référence" },
  en: { title: "Something went wrong", body: "Your membership could not be loaded. Try again.", retry: "Try again", ref: "Reference" },
} as const;

export default function AccountMembershipError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const seg = typeof window === "undefined" ? "nl" : (window.location.pathname.split("/")[1] ?? "nl");
  const text = TEXT[(seg in TEXT ? seg : "nl") as keyof typeof TEXT];
  return <ErrorState title={text.title} description={text.body} requestId={error.digest ?? null} requestIdLabel={text.ref} retry={{ label: text.retry, onClick: reset }} />;
}

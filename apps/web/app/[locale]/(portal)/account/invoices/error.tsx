"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@beam/ui";

/**
 * Error boundary of the portal invoice screens: the localised "Something went wrong, try again"
 * panel with the request id (finance spec section 5). Texts per URL locale, as in the portal's
 * own boundary (an error boundary receives no props and client components have no catalogue).
 */
const TEXT = {
  nl: { title: "Er ging iets mis", body: "Je facturen konden niet geladen worden. Probeer het opnieuw.", retry: "Opnieuw proberen", ref: "Referentie" },
  fr: { title: "Une erreur s’est produite", body: "Vos factures n’ont pas pu être chargées. Réessayez.", retry: "Réessayer", ref: "Référence" },
  en: { title: "Something went wrong", body: "Your invoices could not be loaded. Try again.", retry: "Try again", ref: "Reference" },
} as const;

export default function AccountInvoicesError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const seg = typeof window === "undefined" ? "nl" : (window.location.pathname.split("/")[1] ?? "nl");
  const text = TEXT[(seg in TEXT ? seg : "nl") as keyof typeof TEXT];
  return <ErrorState title={text.title} description={text.body} requestId={error.digest ?? null} requestIdLabel={text.ref} retry={{ label: text.retry, onClick: reset }} />;
}

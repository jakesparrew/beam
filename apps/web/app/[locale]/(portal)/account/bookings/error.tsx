"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@beam/ui";

/** Error boundary of the booking list: request id and retry (booking spec 5); texts per URL locale. */
const TEXT = {
  nl: { title: "Je boekingen konden niet geladen worden", body: "Probeer het opnieuw.", retry: "Opnieuw proberen", ref: "Referentie" },
  fr: { title: "Vos réservations n’ont pas pu être chargées", body: "Réessayez.", retry: "Réessayer", ref: "Référence" },
  en: { title: "Your bookings could not be loaded", body: "Try again.", retry: "Try again", ref: "Reference" },
} as const;

export default function BookingsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const seg = typeof window === "undefined" ? "nl" : (window.location.pathname.split("/")[1] ?? "nl");
  const text = TEXT[(seg in TEXT ? seg : "nl") as keyof typeof TEXT];
  return <ErrorState title={text.title} description={text.body} requestId={error.digest ?? null} requestIdLabel={text.ref} retry={{ label: text.retry, onClick: reset }} />;
}

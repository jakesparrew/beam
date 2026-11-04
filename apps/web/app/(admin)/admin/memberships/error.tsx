"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { ErrorState } from "@beam/ui";

/**
 * "Something went wrong, try again" with the request id for the membership screens (credits spec
 * section 5). Client error boundaries have no catalogue access, so the texts follow `<html lang>`
 * (the same strings as `credits.admin.common.error_title`, `request_id` and `retry`).
 */
const TEXT = {
  "nl-BE": { title: "Er ging iets mis, probeer opnieuw", retry: "Opnieuw proberen", ref: "Aanvraag-id" },
  "fr-BE": { title: "Une erreur s'est produite, réessayez", retry: "Réessayer", ref: "Identifiant de la requête" },
  en: { title: "Something went wrong, try again", retry: "Try again", ref: "Request id" },
} as const;

export default function MembershipsError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const lang = typeof document === "undefined" ? "nl-BE" : document.documentElement.lang;
  const text = TEXT[(lang in TEXT ? lang : "nl-BE") as keyof typeof TEXT];
  return <ErrorState title={text.title} requestId={error.digest ?? null} requestIdLabel={text.ref} retry={{ label: text.retry, onClick: reset }} />;
}

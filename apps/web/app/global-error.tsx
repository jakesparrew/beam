"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Last-resort error page (replaces the root layout). It cannot read the catalogues on the
 * server, so it carries the three short texts itself and picks one from the URL segment.
 */
const TEXT = {
  "nl-BE": { title: "Er ging iets mis", body: "Probeer het opnieuw.", retry: "Opnieuw proberen", ref: "Referentie" },
  "fr-BE": { title: "Une erreur s’est produite", body: "Réessayez.", retry: "Réessayer", ref: "Référence" },
  en: { title: "Something went wrong", body: "Try again.", retry: "Try again", ref: "Reference" },
} as const;

function localeOfLocation(): keyof typeof TEXT {
  if (typeof window === "undefined") return "nl-BE";
  const seg = window.location.pathname.split("/")[1];
  return seg === "fr" ? "fr-BE" : seg === "en" ? "en" : "nl-BE";
}

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);
  const locale = localeOfLocation();
  const text = TEXT[locale];
  return (
    <html lang={locale}>
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0, padding: 32 }}>
        <main>
          <h1>{text.title}</h1>
          <p>{text.body}</p>
          {error.digest ? (
            <p>
              {text.ref}: <code>{error.digest}</code>
            </p>
          ) : null}
          <button type="button" onClick={() => reset()}>
            {text.retry}
          </button>
        </main>
      </body>
    </html>
  );
}

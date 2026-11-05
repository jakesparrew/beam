"use client";
/**
 * The viewer's CTA (webinar spec rules 36, 44): a plain link to the signed click URL
 * (`/api/webinar/cta/<id>?r&m&s`), which records the click and redirects with UTM parameters.
 * The link never carries the access token. When the CTA first renders, `onShown` reports
 * `cta_shown` (once per registration, CTA and mode on the server). It opens in a new tab, so the
 * webinar keeps playing, and says so to screen readers.
 */
import { useEffect, useRef } from "react";
import { buttonVariants, cn } from "@beam/ui";

export type CtaButtonLabels = {
  /** `{label}` is replaced by the CTA text (the player's announcement). */
  announce: string;
  new_tab: string;
};

export type CtaButtonCta = { id: string; label: string; href: string };

export function CtaButton({ cta, labels, onShown }: { cta: CtaButtonCta; labels: CtaButtonLabels; onShown: (ctaId: string) => void }) {
  const reported = useRef<string | null>(null);
  useEffect(() => {
    if (reported.current === cta.id) return;
    reported.current = cta.id;
    onShown(cta.id);
  }, [cta.id, onShown]);

  return (
    <a href={cta.href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ size: "lg" }), "w-full sm:w-auto")} data-testid="webinar-cta">
      {cta.label}
      <span className="sr-only"> {labels.new_tab}</span>
    </a>
  );
}

"use client";
/**
 * The claim countdown of a seat offer (booking spec 5.2, 5.3, 5.4): the expiry in Brussels time
 * and the minutes left, in an `aria-live="polite"` region that updates once a minute (not every
 * second). Texts come from the page: `label` holds `{time}`; `expired` is shown once the offer has
 * run out. The minutes left are shown as a number with the `min` unit of `Intl`.
 */
import { useEffect, useState } from "react";

export type OfferCountdownLabels = { label: string; expired: string };

const MINUTE = 60_000;

export function OfferCountdown({ expiresAt, locale, labels }: { expiresAt: string; locale: string; labels: OfferCountdownLabels }) {
  const end = new Date(expiresAt).getTime();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(id);
  }, []);
  const time = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "full", timeStyle: "short" }).format(new Date(end));
  const left = Math.max(0, Math.ceil((end - now) / MINUTE));
  return (
    <p className="text-sm" aria-live="polite" data-testid="offer-countdown">
      {left > 0 ? (
        <>
          <span>{labels.label.replace("{time}", time)}</span> <span className="text-muted-foreground">({new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long" }).format(left)})</span>
        </>
      ) : (
        <span>{labels.expired}</span>
      )}
    </p>
  );
}

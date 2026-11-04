"use client";

/**
 * The cookie banner (rule 36): a non-modal region fixed at the bottom with "Accept all",
 * "Reject all" and "Choose" of equal visual weight (one shared style, equal grid columns), no
 * pre-ticked box, and a link to the cookie notice. Rendered by `ConsentProvider` only while a
 * choice is needed.
 */
import { useId } from "react";

export type CookieBannerLabels = { title: string; body: string; acceptAll: string; rejectAll: string; choose: string; noticeLink: string };

/** The one button style every banner and dialog choice shares (equal weight, rule 36). */
export const CONSENT_BUTTON_CLASS =
  "inline-flex min-h-11 w-full items-center justify-center rounded-md border border-foreground/20 bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 disabled:opacity-60";

export function CookieBanner({
  labels,
  cookieNoticeHref,
  busy = false,
  onAcceptAll,
  onRejectAll,
  onChoose,
}: {
  labels: CookieBannerLabels;
  cookieNoticeHref: string | null;
  busy?: boolean;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onChoose: () => void;
}) {
  const titleId = useId();
  return (
    <section
      role="region"
      aria-labelledby={titleId}
      data-cookie-banner
      className="fixed inset-x-0 bottom-0 z-40 border-t border-foreground/10 bg-background shadow-[0_-4px_16px_rgba(0,0,0,0.08)]"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-4 md:flex-row md:items-center md:gap-6">
        <div className="flex-1 space-y-1">
          <h2 id={titleId} className="text-base font-semibold">
            {labels.title}
          </h2>
          <p className="text-sm text-muted-foreground">
            {labels.body}{" "}
            {cookieNoticeHref ? (
              <a href={cookieNoticeHref} className="underline hover:no-underline">
                {labels.noticeLink}
              </a>
            ) : null}
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 md:w-[30rem]">
          <button type="button" data-consent="accept_all" className={CONSENT_BUTTON_CLASS} disabled={busy} onClick={onAcceptAll}>
            {labels.acceptAll}
          </button>
          <button type="button" data-consent="reject_all" className={CONSENT_BUTTON_CLASS} disabled={busy} onClick={onRejectAll}>
            {labels.rejectAll}
          </button>
          <button type="button" data-consent="choose" className={CONSENT_BUTTON_CLASS} disabled={busy} onClick={onChoose}>
            {labels.choose}
          </button>
        </div>
      </div>
    </section>
  );
}

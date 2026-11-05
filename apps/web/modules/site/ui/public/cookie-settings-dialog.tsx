"use client";

/**
 * The cookie settings dialog (rules 36-38, section 5): a native modal `<dialog>` opened with
 * `showModal()`, so the rest of the page is inert and focus stays inside; Escape and the close
 * button close it and focus returns to the element that opened it. `necessary` is always on and
 * not a choice; `analytics` and `marketing` start from the visitor's current choice (off for a
 * first visit, nothing pre-ticked; the provider mounts a fresh dialog per opening). "Accept all", "Reject all" and "Save my choice" share one style.
 * Under each category the dialog names its cookies from `COOKIE_INVENTORY` (from R3 the
 * `marketing` switch covers `beam_ref` and the Google Ads and Meta cookies, site-P9).
 */
import { useEffect, useId, useRef, useState } from "react";
import { cookieNamesOf, type ConsentChoices } from "@beam/core/site";
import { CONSENT_BUTTON_CLASS } from "./cookie-banner";

export type CookieDialogLabels = {
  title: string;
  close: string;
  save: string;
  acceptAll: string;
  rejectAll: string;
  noticeLink: string;
  necessary: { title: string; body: string };
  analytics: { title: string; body: string };
  marketing: { title: string; body: string };
};

export function CookieSettingsDialog({
  open,
  labels,
  cookieNoticeHref,
  initial,
  busy = false,
  onClose,
  onSave,
  onAcceptAll,
  onRejectAll,
}: {
  open: boolean;
  labels: CookieDialogLabels;
  cookieNoticeHref: string | null;
  initial: ConsentChoices;
  busy?: boolean;
  onClose: () => void;
  onSave: (choices: ConsentChoices) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const [choices, setChoices] = useState<ConsentChoices>(initial);
  const titleId = useId();
  const ids = { necessary: useId(), analytics: useId(), marketing: useId() };

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open) {
      opener.current = document.activeElement;
      if (!dialog.open) {
        if (typeof dialog.showModal === "function") dialog.showModal();
        else dialog.setAttribute("open", "");
      }
    } else if (dialog.open || dialog.hasAttribute("open")) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
      if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    }
  }, [open]);

  const row = (key: "necessary" | "analytics" | "marketing") => {
    const fixed = key === "necessary";
    const checked = fixed ? true : choices[key];
    return (
      <li className="flex items-start justify-between gap-4 border-t border-foreground/10 py-3 first:border-t-0">
        <div className="space-y-1">
          <label htmlFor={ids[key]} className="font-medium">
            {labels[key].title}
          </label>
          <p id={`${ids[key]}-desc`} className="text-sm text-muted-foreground">
            {labels[key].body}
            <span className="mt-1 block font-mono text-xs" data-cookie-names={key}>
              {cookieNamesOf(key).join(", ")}
            </span>
          </p>
        </div>
        <input
          id={ids[key]}
          type="checkbox"
          role="switch"
          name={key}
          aria-describedby={`${ids[key]}-desc`}
          className="mt-1 size-5 shrink-0 accent-primary"
          checked={checked}
          disabled={fixed || busy}
          onChange={(e) => {
            if (!fixed) setChoices((c) => ({ ...c, [key]: e.target.checked }));
          }}
        />
      </li>
    );
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      data-cookie-dialog
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-lg bg-background p-0 text-foreground shadow-xl backdrop:bg-black/50"
    >
      <div className="space-y-4 p-6">
        <div className="flex items-start justify-between gap-4">
          <h2 id={titleId} className="text-lg font-semibold">
            {labels.title}
          </h2>
          <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm underline hover:no-underline">
            {labels.close}
          </button>
        </div>
        <ul>
          {row("necessary")}
          {row("analytics")}
          {row("marketing")}
        </ul>
        {cookieNoticeHref ? (
          <p className="text-sm">
            <a href={cookieNoticeHref} className="underline hover:no-underline">
              {labels.noticeLink}
            </a>
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button type="button" data-consent="accept_all" className={CONSENT_BUTTON_CLASS} disabled={busy} onClick={onAcceptAll}>
            {labels.acceptAll}
          </button>
          <button type="button" data-consent="reject_all" className={CONSENT_BUTTON_CLASS} disabled={busy} onClick={onRejectAll}>
            {labels.rejectAll}
          </button>
          <button type="button" data-consent="save" className={CONSENT_BUTTON_CLASS} disabled={busy} onClick={() => onSave(choices)}>
            {labels.save}
          </button>
        </div>
      </div>
    </dialog>
  );
}

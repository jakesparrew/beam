"use client";

/**
 * Cookie consent in the browser (site rules 36-40; site-P5). `<ConsentProvider>` reads the
 * `beam_consent` cookie, shows the banner while a choice is needed (no cookie, older than 182
 * days, or a material cookie-notice version newer than the stored one), opens the settings
 * dialog from the banner, from `useConsent().open()` or from any element carrying
 * `data-cookie-settings` (the site footer and the portal chrome), and posts every choice to
 * `/api/public/cookie-consent`, which logs it and sets the cookie. Withdrawing analytics deletes
 * the `_ga*` cookies of the site domain. `useConsent()` gives `{ analytics, marketing, open }`.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Locale } from "@beam/core/i18n";
import {
  choicesFor,
  CONSENT_COOKIE,
  consentAllows,
  cookiesToClearOnWithdraw,
  decodeConsentCookie,
  needsConsentPrompt,
  type ConsentAction,
  type ConsentChoices,
  type ConsentCookie,
} from "@beam/core/site";
import { CookieBanner, type CookieBannerLabels } from "./cookie-banner";
import { CookieSettingsDialog, type CookieDialogLabels } from "./cookie-settings-dialog";

export type ConsentLabels = { banner: CookieBannerLabels; dialog: CookieDialogLabels };

export type ConsentValue = { analytics: boolean; marketing: boolean; open(): void };

const NO_CONSENT: ConsentValue = { analytics: false, marketing: false, open: () => undefined };
const ConsentContext = createContext<ConsentValue>(NO_CONSENT);

/** The visitor's consent; outside a provider nothing is allowed. */
export function useConsent(): ConsentValue {
  return useContext(ConsentContext);
}

/** The `beam_consent` value of `document.cookie`, or null. */
export function readConsentCookie(source: string = typeof document === "undefined" ? "" : document.cookie): ConsentCookie | null {
  for (const part of source.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CONSENT_COOKIE) return decodeConsentCookie(rest.join("="));
  }
  return null;
}

/** Deletes cookies by name on the host and on every parent domain (how GA sets `_ga`). */
export function deleteCookies(names: readonly string[]): void {
  if (typeof document === "undefined" || names.length === 0) return;
  const parts = window.location.hostname.split(".");
  const domains: (string | null)[] = [null];
  for (let i = 0; i < parts.length - 1; i++) domains.push(`.${parts.slice(i).join(".")}`);
  for (const name of names) {
    for (const domain of domains) {
      document.cookie = `${name}=; Max-Age=0; Path=/${domain ? `; Domain=${domain}` : ""}`;
    }
  }
}

function cookieNames(): string[] {
  if (typeof document === "undefined") return [];
  return document.cookie
    .split(";")
    .map((p) => p.trim().split("=")[0] ?? "")
    .filter(Boolean);
}

export type ConsentProviderProps = {
  children?: ReactNode;
  locale: Locale;
  /** Ordinal of the live cookie notice (0 when none is published). */
  bannerVersion: number;
  /** Highest ordinal of a material cookie-notice version, or null. */
  latestMaterialOrdinal: number | null;
  /** The raw `beam_consent` value the server saw (so the first render matches the cookie). */
  initialCookie?: string | null;
  /** Site-relative URL of the cookie notice, when published in this locale. */
  cookieNoticeHref?: string | null;
  /** GA4 measurement id, used to stop GA on withdrawal (`ga-disable-<id>`). */
  gaMeasurementId?: string | null;
  labels: ConsentLabels;
};

export function ConsentProvider({ children, locale, bannerVersion, latestMaterialOrdinal, initialCookie, cookieNoticeHref, gaMeasurementId, labels }: ConsentProviderProps) {
  const [cookie, setCookie] = useState<ConsentCookie | null>(() => decodeConsentCookie(initialCookie ?? null));
  const [prompt, setPrompt] = useState<boolean>(() => needsConsentPrompt(decodeConsentCookie(initialCookie ?? null), { now: new Date(), latestMaterialOrdinal }));
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Each opening mounts a fresh dialog, so its switches start from the current choice.
  const [dialogKey, setDialogKey] = useState(0);
  const open = useCallback(() => {
    setDialogKey((k) => k + 1);
    setDialogOpen(true);
  }, []);

  // Every `[data-cookie-settings]` element (footer button, portal link) opens the dialog.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("[data-cookie-settings]") : null;
      if (!target) return;
      event.preventDefault();
      open();
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [open]);

  const choose = useCallback(
    async (action: ConsentAction, custom?: ConsentChoices) => {
      const choices = choicesFor(action, custom);
      const previous = cookie;
      setBusy(true);
      try {
        const res = await fetch("/api/public/cookie-consent", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ ...(previous?.k ? { consentKey: previous.k } : {}), action, choices, bannerVersion, locale }),
        });
        const fromBrowser = res.ok ? readConsentCookie() : null;
        // The response sets the cookie; without it (offline, blocked) the choice holds for this page only.
        setCookie(fromBrowser ?? { k: previous?.k ?? "", v: bannerVersion, a: choices.analytics, m: choices.marketing, t: Math.floor(Date.now() / 1000) });
      } catch {
        setCookie({ k: previous?.k ?? "", v: bannerVersion, a: choices.analytics, m: choices.marketing, t: Math.floor(Date.now() / 1000) });
      } finally {
        setBusy(false);
      }
      if (!choices.analytics && gaMeasurementId) (window as unknown as Record<string, unknown>)[`ga-disable-${gaMeasurementId}`] = true;
      deleteCookies(cookiesToClearOnWithdraw(cookieNames(), choices));
      setPrompt(false);
      setDialogOpen(false);
    },
    [bannerVersion, cookie, gaMeasurementId, locale],
  );

  const value = useMemo<ConsentValue>(
    () => ({ analytics: !prompt && consentAllows(cookie, "analytics"), marketing: !prompt && consentAllows(cookie, "marketing"), open }),
    [cookie, prompt, open],
  );

  return (
    <ConsentContext.Provider value={value}>
      {children}
      {prompt ? (
        <CookieBanner
          labels={labels.banner}
          cookieNoticeHref={cookieNoticeHref ?? null}
          busy={busy}
          onAcceptAll={() => void choose("accept_all")}
          onRejectAll={() => void choose("reject_all")}
          onChoose={open}
        />
      ) : null}
      <CookieSettingsDialog
        key={dialogKey}
        open={dialogOpen}
        labels={labels.dialog}
        cookieNoticeHref={cookieNoticeHref ?? null}
        initial={{ analytics: !prompt && consentAllows(cookie, "analytics"), marketing: !prompt && consentAllows(cookie, "marketing") }}
        busy={busy}
        onClose={() => setDialogOpen(false)}
        onSave={(choices) => {
          const hadAny = !!cookie && (cookie.a || cookie.m);
          const action: ConsentAction = !choices.analytics && !choices.marketing && hadAny ? "withdraw" : "custom";
          void choose(action, choices);
        }}
        onAcceptAll={() => void choose("accept_all")}
        onRejectAll={() => void choose(cookie && (cookie.a || cookie.m) ? "withdraw" : "reject_all")}
      />
    </ConsentContext.Provider>
  );
}

"use client";

/**
 * Referral capture (site rule 63, R3; site-P9). A page view with `?ref=<CODE>` (8 characters from
 * `A-HJ-NP-Z2-9`; anything else is ignored):
 * - with marketing consent, stores the code in cookie `beam_ref` (30 days, `Secure; SameSite=Lax;
 *   Path=/`) unless a valid code is already stored: the first code wins while the cookie lives;
 * - without marketing consent, sets no cookie and appends `ref=<CODE>` to this page view's
 *   portal (sign-in), checkout and form links only. A click on such a link loads the target with
 *   the code (a client-side `Link` navigation would drop it), so its request handler can read it
 *   through `readReferralCode()`. After a navigation without `?ref=`, nothing is appended any more.
 * Granting marketing consent on the same page view stores the code; withdrawing it deletes
 * `beam_ref` (the consent provider clears the marketing cookies).
 */
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { isReferralTarget, normaliseReferralCode, REFERRAL_COOKIE, REFERRAL_PARAM, referralCaptureAction, referralSetCookie, withReferralCode } from "@beam/core/site";
import { useConsent } from "./consent-provider";

/** The `beam_ref` value of `document.cookie`, or null. */
export function readReferralCookie(source: string = typeof document === "undefined" ? "" : document.cookie): string | null {
  for (const part of source.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === REFERRAL_COOKIE) return normaliseReferralCode(rest.join("="));
  }
  return null;
}

/** Appends `ref=<code>` to every portal, checkout and form link under `root`. */
export function applyReferralLinks(root: ParentNode, code: string, origin: string): void {
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    const next = withReferralCode(href, code, origin);
    if (next !== href) a.setAttribute("href", next);
  }
}

/** Removes `ref=<code>` again from the links `applyReferralLinks` changed (the next page view must not carry it). */
export function stripReferralLinks(root: ParentNode, code: string, origin: string): void {
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (!isReferralTarget(href, origin)) continue;
    try {
      const url = new URL(href, origin);
      if (url.searchParams.get(REFERRAL_PARAM) !== code) continue;
      url.searchParams.delete(REFERRAL_PARAM);
      a.setAttribute("href", /^[a-z][a-z0-9+.-]*:/i.test(href) ? url.toString() : `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // Unparseable href: left as it is.
    }
  }
}

export function ReferralCapture() {
  const { marketing } = useConsent();
  const pathname = usePathname();

  useEffect(() => {
    const code = normaliseReferralCode(new URLSearchParams(window.location.search).get(REFERRAL_PARAM));
    const action = referralCaptureAction({ code, stored: readReferralCookie(), marketing });
    if (action === "set" && code) {
      document.cookie = referralSetCookie(code);
      return;
    }
    if (action !== "links" || !code) return;
    const origin = window.location.origin;
    applyReferralLinks(document, code, origin);
    const observer = typeof MutationObserver === "function" ? new MutationObserver(() => applyReferralLinks(document, code, origin)) : null;
    observer?.observe(document.body, { childList: true, subtree: true });
    // A client-side `Link` navigates to its own `href` prop; load the link with the code instead.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!isReferralTarget(href, origin)) return;
      event.preventDefault();
      event.stopPropagation();
      window.location.assign(withReferralCode(href, code, origin));
    };
    document.addEventListener("click", onClick, true);
    return () => {
      observer?.disconnect();
      document.removeEventListener("click", onClick, true);
      stripReferralLinks(document, code, origin);
    };
  }, [marketing, pathname]);

  return null;
}

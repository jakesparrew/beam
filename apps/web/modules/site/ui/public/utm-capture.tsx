"use client";

/**
 * UTM capture (rule 40; site-P5). Only after analytics consent, the first landing of the visit
 * keeps its `utm_*` parameters and landing path in `sessionStorage` (`beam_utm`), so a form on a
 * later page of the same visit can still attribute the lead. Without consent nothing is stored
 * (the form on the landing page itself receives the UTM from the URL), and withdrawing consent
 * removes the stored values.
 */
import { useEffect } from "react";
import { UTM_STORAGE_KEY, utmFromSearch, type StoredUtm } from "@beam/core/site";
import { useConsent } from "./consent-provider";

// The helpers live in `@beam/core/site` (client-safe; forms reads the stored landing there).
export { readStoredUtm, UTM_STORAGE_KEY, utmFromSearch, type StoredUtm } from "@beam/core/site";

export function UtmCapture() {
  const { analytics } = useConsent();
  useEffect(() => {
    let storage: Storage;
    try {
      storage = window.sessionStorage;
    } catch {
      return;
    }
    try {
      if (!analytics) {
        storage.removeItem(UTM_STORAGE_KEY);
        return;
      }
      if (storage.getItem(UTM_STORAGE_KEY)) return;
      const utm = utmFromSearch(window.location.search);
      if (Object.keys(utm).length === 0) return;
      const value: StoredUtm = { utm, landingPath: window.location.pathname };
      storage.setItem(UTM_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Storage full or blocked: attribution falls back to the landing page's own form.
    }
  }, [analytics]);
  return null;
}

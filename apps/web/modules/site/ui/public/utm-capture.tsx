"use client";

/**
 * UTM capture (rule 40; site-P5). Only after analytics consent, the first landing of the visit
 * keeps its `utm_*` parameters and landing path in `sessionStorage` (`beam_utm`), so a form on a
 * later page of the same visit can still attribute the lead. Without consent nothing is stored
 * (the form on the landing page itself receives the UTM from the URL), and withdrawing consent
 * removes the stored values.
 */
import { useEffect } from "react";
import type { UtmParams } from "@beam/core/forms";
import { useConsent } from "./consent-provider";

export const UTM_STORAGE_KEY = "beam_utm";
const UTM_KEYS = ["source", "medium", "campaign", "term", "content"] as const;

export type StoredUtm = { utm: UtmParams; landingPath: string };

/** The `utm_*` values of a query string (at most 200 characters each). */
export function utmFromSearch(search: string): UtmParams {
  const params = new URLSearchParams(search);
  const out: UtmParams = {};
  for (const key of UTM_KEYS) {
    const v = params.get(`utm_${key}`);
    if (v && v.length <= 200) out[key] = v;
  }
  return out;
}

/** The stored landing of this visit, or null (no consent, nothing stored, storage blocked). */
export function readStoredUtm(storage: Pick<Storage, "getItem"> | null = typeof window === "undefined" ? null : window.sessionStorage): StoredUtm | null {
  try {
    const raw = storage?.getItem(UTM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredUtm;
    return parsed && typeof parsed.landingPath === "string" && parsed.utm && typeof parsed.utm === "object" ? parsed : null;
  } catch {
    return null;
  }
}

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

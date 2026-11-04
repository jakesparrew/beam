/**
 * UTM attribution of a visit (rule 40; site-P5), client-safe: no server code, no React. Site's
 * `UtmCapture` stores the first landing's `utm_*` values and path in `sessionStorage`
 * (`beam_utm`) after analytics consent; a form on a later page reads them with `readStoredUtm()`.
 * Client components import these from `@beam/core/site`; `modules/site/api` re-exports them for
 * server code, but that barrel also carries server-only functions.
 */
import type { UtmParams } from "../forms/types";

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

/** `window.sessionStorage`, or null on the server or when the browser blocks storage. */
function sessionStorageOrNull(): Pick<Storage, "getItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The stored landing of this visit, or null (no consent, nothing stored, storage blocked, malformed). */
export function readStoredUtm(storage: Pick<Storage, "getItem"> | null = sessionStorageOrNull()): StoredUtm | null {
  try {
    const raw = storage?.getItem(UTM_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredUtm;
    return parsed && typeof parsed.landingPath === "string" && parsed.utm && typeof parsed.utm === "object" ? parsed : null;
  } catch {
    return null;
  }
}

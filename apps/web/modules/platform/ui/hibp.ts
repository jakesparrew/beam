/**
 * Have I Been Pwned range check, run in the browser only (PL-1): SHA-1 with WebCrypto, then
 * `GET https://api.pwnedpasswords.com/range/<first 5 hex>` with `Add-Padding: true` and a
 * 1.5 s timeout. Only the 5-character prefix leaves the browser. A timeout or any error
 * answers `unknown`, which allows submit; the server never contacts HIBP.
 */
export const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";
export const HIBP_TIMEOUT_MS = 1500;

export type PwnedVerdict = "breached" | "ok" | "unknown";

export async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** True when the range response lists `suffix` with a count above 0 (padding rows have count 0). */
export function rangeContains(body: string, suffix: string): boolean {
  for (const line of body.split(/\r?\n/)) {
    const [hash, count] = line.trim().split(":");
    if (hash?.toUpperCase() === suffix && Number(count ?? 0) > 0) return true;
  }
  return false;
}

export async function checkPwnedPassword(
  password: string,
  opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<PwnedVerdict> {
  if (!password) return "unknown";
  const doFetch = opts.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hash = await sha1Hex(password);
    // The timeout covers the request only (a slow hash must not abort it before it starts).
    timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? HIBP_TIMEOUT_MS);
    const prefix = hash.slice(0, 5);
    const response = await doFetch(`${HIBP_RANGE_URL}${prefix}`, {
      headers: { "Add-Padding": "true" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) return "unknown";
    return rangeContains(await response.text(), hash.slice(5)) ? "breached" : "ok";
  } catch {
    return "unknown";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

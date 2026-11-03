import { createHash } from "node:crypto";

/** Parameter names whose values never enter a digest. */
const SECRET_PARAM = /key|token|secret|password|signature|authorization|auth|session|cookie/i;

export type DigestInput = {
  method: string;
  /** Path without host; a query string in it is merged with `params`. */
  path: string;
  params?: Record<string, string | number | boolean | null | undefined | readonly (string | number)[]>;
};

/**
 * sha256 hex of the canonical request: upper-case method, path, and the sorted non-secret
 * params (`integration_calls.request_digest`). Bodies are never part of it.
 */
export function digestRequest(input: DigestInput): string {
  const [rawPath = "", query = ""] = input.path.split("?", 2);
  const pairs: [string, string][] = [];
  for (const [k, v] of new URLSearchParams(query)) pairs.push([k, v]);
  for (const [k, v] of Object.entries(input.params ?? {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) for (const item of v) pairs.push([k, String(item)]);
    else pairs.push([k, String(v)]);
  }
  const canonical = pairs
    .filter(([k]) => !SECRET_PARAM.test(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return createHash("sha256").update(`${input.method.toUpperCase()} ${rawPath}${canonical ? `?${canonical}` : ""}`).digest("hex");
}

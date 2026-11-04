/**
 * WordPress (old site) media client (site spec section 6, used only during the migration by
 * `site.fetch_wordpress_media`). It downloads one attachment at a time with a GET, and only from
 * the import's `site_origin` or from a CDN host that the WXR file lists for `/wp-content/uploads/`.
 * 20 s timeout, 10 MB cap, image types of platform's `files_mime_ck` only. Every call is reported
 * through `onCall` (provider `wordpress`: operation, digest, status, duration; never bodies).
 *
 * Errors: 404 and 410 are `IntegrationError` code `media_missing` (permanent: the job marks the
 * item `error` and continues), a refused origin `origin_refused`, a disallowed type
 * `mime_not_allowed`, a file over the cap `too_large` (all permanent); 5xx, 408, 429 and network
 * failures are retryable, so the job's chunk retries.
 */
import { digestRequest } from "../_shared/digest";
import { errorFromStatus, IntegrationError } from "../_shared/errors";
import { trackCall, withTimeout } from "../_shared/timeout";
import { noopOnCall, type FetchLike, type OnCall } from "../_shared/types";

/** The call logger a job passes (`ctx.integrationLog`). */
export type IntegrationCallLogger = OnCall;

export const WORDPRESS_MEDIA_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const WORDPRESS_DEFAULT_TIMEOUT_MS = 20_000;
export const WORDPRESS_DEFAULT_MAX_BYTES = 10_485_760;
/** The only path a CDN host may serve from. */
export const WORDPRESS_UPLOADS_PREFIX = "/wp-content/uploads/";

export type WordpressMedia = { bytes: Uint8Array; mime: string; sizeBytes: number };

export type WordpressMediaClientOptions = {
  /** The import's `site_origin`, for example `https://www.beam.be`. */
  allowedOrigin: string;
  /** CDN origins listed in the WXR file; allowed only for `/wp-content/uploads/` paths. */
  cdnOrigins?: readonly string[];
  timeoutMs?: number;
  maxBytes?: number;
  onCall: IntegrationCallLogger;
  /** Injected in tests (no network in tests). */
  fetch?: FetchLike;
};

/** The interface the job depends on (the class below and `FakeWordpressMediaClient`). */
export interface WordpressMediaSource {
  fetchMedia(url: string): Promise<WordpressMedia>;
}

const OPERATION = "media.get";

function originOf(value: string): string | null {
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The bare mime type of a `content-type` header (`image/jpeg; charset=…` -> `image/jpeg`). */
export function bareMime(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

function refused(code: string, message: string, statusCode?: number): IntegrationError {
  return new IntegrationError({ provider: "wordpress", operation: OPERATION, retryable: false, code, message, ...(statusCode !== undefined ? { statusCode } : {}) });
}

export class WordpressMediaClient implements WordpressMediaSource {
  private readonly origin: string;
  private readonly cdn: readonly string[];
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly onCall: OnCall;
  private readonly doFetch: FetchLike;

  constructor(opts: WordpressMediaClientOptions) {
    const origin = originOf(opts.allowedOrigin);
    if (!origin) throw new TypeError("WordpressMediaClient: allowedOrigin must be an https origin");
    this.origin = origin;
    this.cdn = (opts.cdnOrigins ?? []).map(originOf).filter((o): o is string => !!o && o !== origin);
    this.timeoutMs = opts.timeoutMs ?? WORDPRESS_DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? WORDPRESS_DEFAULT_MAX_BYTES;
    this.onCall = opts.onCall ?? noopOnCall;
    this.doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** True when `url` may be fetched: the site origin, or a listed CDN origin under `/wp-content/uploads/`. */
  allows(url: string): boolean {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== "https:" || u.username || u.password) return false;
    const origin = u.origin.toLowerCase();
    if (origin === this.origin) return true;
    return this.cdn.includes(origin) && u.pathname.startsWith(WORDPRESS_UPLOADS_PREFIX);
  }

  async fetchMedia(url: string): Promise<WordpressMedia> {
    if (!this.allows(url)) throw refused("origin_refused", "wordpress media.get: URL is not on the import's site origin");
    const u = new URL(url);
    const requestDigest = digestRequest({ method: "GET", path: `${u.host}${u.pathname}` });
    return trackCall(this.onCall, { provider: "wordpress", operation: OPERATION, requestDigest }, () =>
      withTimeout(
        async (signal) => {
          const res = await this.doFetch(u.toString(), { method: "GET", redirect: "manual", signal, headers: { accept: WORDPRESS_MEDIA_MIMES.join(", ") } });
          if (res.status === 404 || res.status === 410) throw refused("media_missing", `wordpress media.get failed with ${res.status}`, res.status);
          if (!res.ok) throw errorFromStatus("wordpress", OPERATION, res.status);
          const mime = bareMime(res.headers.get("content-type"));
          if (!(WORDPRESS_MEDIA_MIMES as readonly string[]).includes(mime)) throw refused("mime_not_allowed", `wordpress media.get: type ${mime || "unknown"} is not allowed`, res.status);
          const declared = Number(res.headers.get("content-length") ?? "NaN");
          if (Number.isFinite(declared) && declared > this.maxBytes) throw refused("too_large", "wordpress media.get: file is larger than the cap", res.status);
          const bytes = await readCapped(res, this.maxBytes);
          if (!bytes) throw refused("too_large", "wordpress media.get: file is larger than the cap", res.status);
          return { value: { bytes, mime, sizeBytes: bytes.byteLength }, statusCode: res.status };
        },
        this.timeoutMs,
        { provider: "wordpress", operation: OPERATION },
      ),
    );
  }
}

/** Reads the body, stopping (null) as soon as it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > max ? null : buf;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

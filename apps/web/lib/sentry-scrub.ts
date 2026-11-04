/**
 * Scrubbing shared by the browser and server Sentry configs (PL-72). It has no server-only
 * imports, so `instrumentation-client.ts` can use it. Besides emails and phone numbers in free
 * text, it removes secrets from URLs: path tokens (`/admin/reset-password/<token>`,
 * `/admin/invite/<token>`) become `[token]` and the query string and fragment are dropped (magic
 * links carry `token` and `email` there). URLs appear in `request.url`, transaction names,
 * the `url.full` / `http.url` span data and navigation/fetch breadcrumbs.
 */

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// International or Belgian numbers: +32 470 12 34 56, 0470/12.34.56, 0032470123456.
const PHONE = /(?:\+|00)\d[\d\s./-]{7,}\d|\b0\d{1,3}[\s./-]?\d{2,3}[\s./-]?\d{2}[\s./-]?\d{2}\b/g;
const PATH_TOKEN = /\/(reset-password|invite)\/[^/?#]+/g;

/** Masks email addresses and phone numbers in free text. */
export function maskText(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
}

/** A URL or path without its query, fragment or path tokens. Non-strings pass through. */
export function scrubUrl<T>(value: T): T {
  if (typeof value !== "string") return value;
  const cut = value.search(/[?#]/);
  const base = cut >= 0 ? value.slice(0, cut) : value;
  return maskText(base.replace(PATH_TOKEN, "/$1/[token]")) as T;
}

const URL_KEYS = ["url", "url.full", "http.url", "from", "to", "http.target", "url.path"] as const;

function scrubData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const k of URL_KEYS) if (k in data) data[k] = scrubUrl(data[k]);
  if ("http.query" in data) delete data["http.query"];
  if ("url.query" in data) delete data["url.query"];
}

export type ScrubbableEvent = {
  message?: string;
  transaction?: string;
  request?: { url?: string; data?: unknown; cookies?: unknown; headers?: Record<string, string>; query_string?: unknown };
  exception?: { values?: { value?: string }[] };
  breadcrumbs?: { message?: string; data?: Record<string, unknown> }[];
  user?: Record<string, unknown>;
  contexts?: { trace?: { data?: Record<string, unknown> } & Record<string, unknown> } & Record<string, unknown>;
  spans?: { description?: string; data?: Record<string, unknown> }[];
};

/**
 * Sentry `beforeSend` and `beforeSendTransaction`: no request bodies, cookies, auth headers or
 * query strings; emails and phones masked; tokens removed from every URL the event carries.
 */
export function scrubEvent<E extends ScrubbableEvent>(event: E): E {
  if (event.message) event.message = maskText(event.message);
  if (event.transaction) event.transaction = scrubUrl(event.transaction);
  if (event.request) {
    delete event.request.data;
    delete event.request.cookies;
    delete event.request.query_string;
    if (event.request.url) event.request.url = scrubUrl(event.request.url);
    if (event.request.headers) {
      for (const h of Object.keys(event.request.headers)) {
        if (/^(cookie|authorization|set-cookie)$/i.test(h)) delete event.request.headers[h];
        else if (/^referer$/i.test(h)) event.request.headers[h] = scrubUrl(event.request.headers[h]!);
      }
    }
  }
  for (const v of event.exception?.values ?? []) if (v.value) v.value = maskText(v.value);
  for (const b of event.breadcrumbs ?? []) {
    if (b.message) b.message = maskText(scrubUrlsIn(b.message));
    scrubData(b.data);
  }
  scrubData(event.contexts?.trace?.data);
  for (const s of event.spans ?? []) {
    if (s.description) s.description = scrubUrlsIn(s.description);
    scrubData(s.data);
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {};
  return event;
}

/** Scrubs URL-looking parts inside free text (`GET /admin/invite/abc?x=1`). */
function scrubUrlsIn(text: string): string {
  return text.replace(/(?:https?:\/\/[^\s"']+|\/[^\s"']*)/g, (m) => scrubUrl(m));
}

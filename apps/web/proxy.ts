/**
 * The request proxy (Next.js 16 `proxy.ts`, Node runtime; DR-21). Per request it:
 * - negotiates the locale of site and portal paths (PL-65): the URL segment, then the
 *   `NEXT_LOCALE` cookie, then `Accept-Language`, then `nl-BE`; a bare path gets a 307 to the
 *   negotiated prefix;
 * - sends `/admin/*` and `/:locale/account/*` without a session cookie to their login page with
 *   a same-origin `returnTo` (presence only, no database call: the layouts run `requireStaff()`
 *   and `requireCustomer()`, runbook DR-11);
 * - answers 410 Gone for the legacy WordPress paths of `isLegacyGone()` (with or without a
 *   locale prefix; a page can only answer 404);
 * - sets the CSP with a fresh nonce (`x-nonce` request header for `next/script`) and the
 *   static security headers (PL-67).
 */
import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_LOCALE, localeFromAcceptLanguage, localeFromSegment, t, URL_SEGMENT, isLocale, type Locale } from "@beam/core/i18n";
import { isLegacyGone } from "@beam/core/site";
import { SESSION_COOKIE } from "./lib/auth-config";
import { buildCsp, generateNonce, SECURITY_HEADERS } from "./lib/csp";

export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Admin pages that render without a session. */
const ADMIN_PUBLIC = [/^\/admin\/login\/?$/, /^\/admin\/invite\/[^/]+\/?$/, /^\/admin\/reset-password(\/[^/]+)?\/?$/];

function cookieLocale(value: string | undefined): Locale | null {
  if (!value) return null;
  return isLocale(value) ? value : localeFromSegment(value);
}

/** PL-65 steps 2 to 4 (the URL segment is step 1). */
export function negotiateLocale(request: NextRequest): Locale {
  return cookieLocale(request.cookies.get(LOCALE_COOKIE)?.value) ?? localeFromAcceptLanguage(request.headers.get("accept-language")) ?? DEFAULT_LOCALE;
}

function withSecurityHeaders(response: NextResponse, csp: string): NextResponse {
  response.headers.set("Content-Security-Policy", csp);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}

function redirectTo(request: NextRequest, pathname: string, params: Record<string, string> = {}): NextResponse {
  const url = request.nextUrl.clone();
  url.pathname = pathname;
  url.search = "";
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url, 307);
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * The 410 page of a legacy WordPress path (site spec section 5: localised, with navigation back to
 * home). A page can answer only 404 through `notFound()`, so the proxy writes this small document
 * itself, in the URL's (or the negotiated) locale; no script, no inline style.
 */
function goneResponse(locale: Locale): NextResponse {
  const tr = (key: string) => escapeHtml(t(locale, key));
  const html =
    `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${tr("site.public.gone.title")}</title></head>` +
    `<body><main data-status="410"><h1>${tr("site.public.gone.title")}</h1><p>${tr("site.public.gone.body")}</p>` +
    `<p><a href="/${URL_SEGMENT[locale]}">${tr("site.public.notFound.home")}</a></p></main></body></html>`;
  return new NextResponse(html, { status: 410, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=3600" } });
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const nonce = generateNonce();
  const csp = buildCsp({ nonce, pathname });
  const hasSession = !!request.cookies.get(SESSION_COOKIE)?.value;
  const returnTo = `${pathname}${search}`;

  const firstSegment = pathname.split("/")[1] ?? "";
  const urlLocale = localeFromSegment(firstSegment);
  const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");

  if (!isAdmin && isLegacyGone(pathname)) {
    return withSecurityHeaders(goneResponse(urlLocale ?? negotiateLocale(request)), csp);
  }

  if (isAdmin) {
    if (!hasSession && !ADMIN_PUBLIC.some((re) => re.test(pathname))) {
      return withSecurityHeaders(redirectTo(request, "/admin/login", { returnTo }), csp);
    }
  } else if (!urlLocale) {
    // A bare site or portal path: 307 to the negotiated prefix (PL-65).
    const seg = URL_SEGMENT[negotiateLocale(request)];
    const url = request.nextUrl.clone();
    url.pathname = pathname === "/" ? `/${seg}` : `/${seg}${pathname}`;
    return withSecurityHeaders(NextResponse.redirect(url, 307), csp);
  } else {
    const rest = pathname.slice(firstSegment.length + 1);
    const isPortal = rest === "/account" || rest.startsWith("/account/");
    const isPortalLogin = /^\/account\/login(\/|$)/.test(rest);
    if (isPortal && !isPortalLogin && !hasSession) {
      return withSecurityHeaders(redirectTo(request, `/${firstSegment}/account/login`, { returnTo }), csp);
    }
  }

  const headers = new Headers(request.headers);
  headers.set("x-nonce", nonce);
  // Next.js reads the nonce from the request's CSP header and puts it on its own scripts.
  headers.set("Content-Security-Policy", csp);
  headers.set("x-pathname", returnTo);
  if (urlLocale) headers.set("x-beam-locale", urlLocale);
  else headers.delete("x-beam-locale");
  const response = NextResponse.next({ request: { headers } });
  if (urlLocale && request.cookies.get(LOCALE_COOKIE)?.value !== firstSegment) {
    response.cookies.set(LOCALE_COOKIE, firstSegment, { path: "/", sameSite: "lax", maxAge: 365 * 24 * 3600 });
  }
  return withSecurityHeaders(response, csp);
}

export const config = {
  // Every page path: `/`, `/admin/*`, `/:locale(nl|fr|en)/*` and bare paths that need a prefix.
  // API routes, Next internals and static files (by their extension) are left alone. Only real
  // file extensions: signed tokens end in ".<signature>" (`/nl/w/<id>.<n>.<sig>`), and with "any
  // extension" a token whose signature had only letters and digits skipped the proxy, so its
  // page went out without CSP or security headers.
  // The second entry lets the legacy WordPress files (`/wp-login.php`, `/nl/xmlrpc.php`, ...) reach the 410.
  matcher: [
    "/((?!api/|_next/|favicon\\.ico|sw\\.js|manifest\\.webmanifest|robots\\.txt|sitemap\\.xml|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|map|txt|xml|json|woff2?|ttf|otf|pdf|webmanifest|mp4|webm|mp3|zip|csv)$).*)",
    "/((?:nl/|fr/|en/)?(?:wp-login\\.php|xmlrpc\\.php|wp-includes/.*|wp-admin/.*|wp-json/.*))",
  ],
};

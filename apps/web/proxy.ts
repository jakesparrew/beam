/**
 * The request proxy (Next.js 16 `proxy.ts`, Node runtime; DR-21). Per request it:
 * - negotiates the locale of site and portal paths (PL-65): the URL segment, then the
 *   `NEXT_LOCALE` cookie, then `Accept-Language`, then `nl-BE`; a bare path gets a 307 to the
 *   negotiated prefix;
 * - sends `/admin/*` and `/:locale/account/*` without a session cookie to their login page with
 *   a same-origin `returnTo` (presence only, no database call: the layouts run `requireStaff()`
 *   and `requireCustomer()`, runbook DR-11);
 * - sets the CSP with a fresh nonce (`x-nonce` request header for `next/script`) and the
 *   static security headers (PL-67).
 */
import { NextResponse, type NextRequest } from "next/server";
import { DEFAULT_LOCALE, localeFromAcceptLanguage, localeFromSegment, URL_SEGMENT, isLocale, type Locale } from "@beam/core/i18n";
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

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const nonce = generateNonce();
  const csp = buildCsp({ nonce, pathname });
  const hasSession = !!request.cookies.get(SESSION_COOKIE)?.value;
  const returnTo = `${pathname}${search}`;

  const firstSegment = pathname.split("/")[1] ?? "";
  const urlLocale = localeFromSegment(firstSegment);
  const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");

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
  // API routes, Next internals and files with an extension are left alone.
  matcher: ["/((?!api/|_next/|favicon\\.ico|sw\\.js|manifest\\.webmanifest|robots\\.txt|sitemap\\.xml|.*\\.[a-zA-Z0-9]+$).*)"],
};

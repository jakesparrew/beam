/**
 * Links inside page content and menus (site spec section 4) and the portal entry points
 * (rule 31). `href` must be `https:`, `mailto:`, `tel:` or a site path; `javascript:` and
 * `data:` are rejected (rule 20).
 */
import { z } from "zod";
import type { Locale } from "../i18n";
import { prefixFromLocale } from "./locales";
import type { PortalRoute } from "./types";

export const PORTAL_ROUTES = [
  "home",
  "book_day",
  "book_night",
  "bookings",
  "waitlist",
  "shop",
  "packages",
  "membership",
  "invoices",
  "preferences",
  "profile",
] as const satisfies readonly PortalRoute[];

/** Path below `/<prefix>` and fixed query of each portal route. */
const PORTAL_TARGETS: Record<PortalRoute, { path: string; query?: Record<string, string> }> = {
  home: { path: "account" },
  book_day: { path: "account/book", query: { kind: "day" } },
  book_night: { path: "account/book", query: { kind: "night" } },
  bookings: { path: "account/bookings" },
  waitlist: { path: "account/waitlist" },
  shop: { path: "account/shop" },
  packages: { path: "account/packages" },
  membership: { path: "account/membership" },
  invoices: { path: "account/invoices" },
  preferences: { path: "account/preferences" },
  profile: { path: "account/profile" },
};

/** Site-relative portal URL, e.g. `/nl/account/book?kind=day` (api `portalUrl`). */
export function portalPath(locale: Locale, route: PortalRoute, params?: Record<string, string>): string {
  const target = PORTAL_TARGETS[route];
  const query = new URLSearchParams({ ...(target.query ?? {}), ...(params ?? {}) }).toString();
  return `/${prefixFromLocale(locale)}/${target.path}${query ? `?${query}` : ""}`;
}

/** True for `https://…`, `mailto:…`, `tel:…` and same-site paths (`/…`, not `//…`). */
export function isSafeHref(href: string): boolean {
  const value = href.trim();
  if (value !== href || value.length === 0 || value.length > 500) return false;
  if (/\s/.test(value) || [...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return false;
  if (value.startsWith("/")) return !value.startsWith("//") && !value.startsWith("/\\");
  const lower = value.toLowerCase();
  if (lower.startsWith("https://")) {
    try {
      return new URL(value).protocol === "https:";
    } catch {
      return false;
    }
  }
  if (lower.startsWith("mailto:")) return value.length > 7;
  if (lower.startsWith("tel:")) return /^tel:\+?[0-9().-]{3,30}$/i.test(value);
  return false;
}

/** True for an absolute `https:` URL (not a site path). */
export function isExternalHref(href: string): boolean {
  return /^https:\/\//i.test(href);
}

export const SafeHref = z.string().refine(isSafeHref, { message: "href must be https:, mailto:, tel: or a site path" });

export const LinkSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("page"), pageId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("url"), href: SafeHref }).strict(),
  z.object({ kind: z.literal("portal"), route: z.enum(PORTAL_ROUTES) }).strict(),
]);

export type Link = { kind: "page"; pageId: string } | { kind: "url"; href: string } | { kind: "portal"; route: PortalRoute };

/** Attributes of a rendered external link: same tab, `rel="noopener"` (rule 20). */
export function externalLinkRel(href: string): string | undefined {
  return isExternalHref(href) ? "noopener" : undefined;
}

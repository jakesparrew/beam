/**
 * `PortalSiteChrome` (site spec section 5, cross-module D65): the terms banner, consent-gated
 * analytics and the "Cookie settings" link around platform's `PortalShell`. Internal to the site
 * module (not exported from `api.ts`); used only by site's portal layout. Stub by site-P1 that
 * renders nothing; site-P6 implements it.
 */
import type { Locale } from "@beam/core/i18n";

export function PortalSiteChrome(_props: { locale: Locale }): null {
  return null;
}

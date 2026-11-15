import type { MetadataRoute } from "next";
import { getSitemapEntries } from "@/modules/site/server/sitemap";

/**
 * sitemap.xml: every live, indexable route with hreflang alternates (site-P5, tag `site:sitemap`).
 * Rendered on request (like robots.txt) so the build never needs the database; the entries
 * themselves stay in the site data cache.
 */
export const dynamic = "force-dynamic";

export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return getSitemapEntries();
}

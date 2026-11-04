import type { MetadataRoute } from "next";
import { getSitemapEntries } from "@/modules/site/server/sitemap";

/** sitemap.xml: every live, indexable route with hreflang alternates (site-P5, tag `site:sitemap`). */
export const revalidate = 3600;

export default function sitemap(): Promise<MetadataRoute.Sitemap> {
  return getSitemapEntries();
}

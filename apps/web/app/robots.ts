import type { MetadataRoute } from "next";
import { getAppDb } from "@/lib/ctx";
import { reportError } from "@/lib/logger";
import { canonicalOrigin } from "@/modules/site/server/urls";
import { isProductionEnv, robotsFor } from "@/modules/site/server/sitemap";

/** robots.txt (site-P5): production allows the site and names the sitemap; other environments `Disallow: /`. */
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const isProduction = isProductionEnv();
  let origin = "https://www.beam.be";
  if (isProduction) {
    try {
      origin = await canonicalOrigin(await getAppDb());
    } catch (error) {
      reportError(error, { tags: { module: "site", step: "robots" } });
    }
  }
  return robotsFor({ isProduction, origin });
}

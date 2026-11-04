/**
 * Cache invalidation of the public site (site rule 7, section 4; site-P3). Public queries are
 * wrapped in `unstable_cache` with the tags below (`queries/public.ts`, `server/legal.ts`,
 * `server/sitemap.ts`, `server/consent.ts`); a publish, unpublish, archive, menu or redirect change
 * calls `revalidateSite` after its transaction committed. Outside a Next.js request (Vitest,
 * jobs run by scripts) `revalidateTag` throws; the call is then a no-op, because nothing is cached.
 */
import { revalidateTag } from "next/cache";

/** Every tag a page change can affect (rule 7 plus the list caches of `queries/public.ts`). */
export function pageTags(pageId: string): string[] {
  return [`site:page:${pageId}`, "site:pages", "site:routes", "site:nav", "site:sitemap", "site:posts", "site:events"];
}

export const NAV_TAGS = ["site:nav"] as const;
export const REDIRECT_TAGS = ["site:routes"] as const;
export const MEDIA_TAGS = ["site:pages", "site:routes"] as const;

/** Revalidates each tag with the `max` profile (Next 16: stale content is served while refreshing). */
export function revalidateSite(tags: readonly string[]): void {
  for (const tag of new Set(tags)) {
    try {
      revalidateTag(tag, "max");
    } catch {
      // Outside a request scope (tests, scripts): nothing is cached, so nothing to revalidate.
    }
  }
}

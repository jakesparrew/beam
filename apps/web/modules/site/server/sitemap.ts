/**
 * sitemap.xml and robots.txt (site spec section 4 route table, rule 29; site-P5). The sitemap
 * lists every live route of an indexable page with its hreflang alternates and
 * `lastModified = published_at`; it leaves out locales marked `noindex`, the guardian consent
 * page, cancelled events and events that ended more than 30 days ago. robots.txt allows the
 * site in production only.
 */
import type { MetadataRoute } from "next";
import { unstable_cache } from "next/cache";
import type { DbOrTx } from "@beam/db";
import { pageRoutes, pages, pageVersions, sessions } from "@beam/db/schema";
import { LOCALES, type Locale } from "@beam/core/i18n";
import { localePath, type PageKind, type PageSeo } from "@beam/core/site";
import { eq, getAppDb, inArray } from "@/lib/ctx";
import { isNoindex } from "./metadata";
import { absoluteUrl, canonicalOrigin } from "./urls";

type LiveRoute = {
  pageId: string;
  kind: PageKind;
  legalKey: string | null;
  sessionId: string | null;
  locale: Locale;
  path: string;
  publishedAt: Date | string | null;
  seo: Partial<Record<Locale, PageSeo>> | null;
};

/** The sitemap entries for `db` at `now` (pure of the Next cache, for tests and the route). */
export async function loadSitemapEntries(db: DbOrTx, opts: { now?: Date } = {}): Promise<MetadataRoute.Sitemap> {
  const now = opts.now ?? new Date();
  const rows: LiveRoute[] = await db
    .select({
      pageId: pages.id,
      kind: pages.kind,
      legalKey: pages.legalKey,
      sessionId: pages.sessionId,
      locale: pageRoutes.locale,
      path: pageRoutes.path,
      publishedAt: pageVersions.publishedAt,
      seo: pageVersions.seo,
    })
    .from(pageRoutes)
    .innerJoin(pages, eq(pages.id, pageRoutes.pageId))
    .innerJoin(pageVersions, eq(pageVersions.id, pages.currentVersionId))
    .where(eq(pages.status, "published"))
    .then((r) => r as LiveRoute[]);
  if (rows.length === 0) return [];

  const sessionIds = [...new Set(rows.map((r) => r.sessionId).filter((id): id is string => !!id))];
  const events = new Map<string, { endsAt: Date; status: string }>();
  if (sessionIds.length > 0) {
    const found = await db.select({ id: sessions.id, endsAt: sessions.endsAt, status: sessions.status }).from(sessions).where(inArray(sessions.id, sessionIds));
    for (const s of found) events.set(s.id, { endsAt: s.endsAt, status: s.status });
  }

  const indexable = rows.filter((r) => {
    const event = r.sessionId ? (events.get(r.sessionId) ?? null) : null;
    return !isNoindex(
      { kind: r.kind, legalKey: r.legalKey, title: "", seo: r.seo?.[r.locale] ?? null, routes: {} },
      { isProduction: true, now, event },
    );
  });

  const byPage = new Map<string, LiveRoute[]>();
  for (const r of indexable) byPage.set(r.pageId, [...(byPage.get(r.pageId) ?? []), r]);

  const origin = await canonicalOrigin(db);
  const url = (r: LiveRoute) => absoluteUrl(origin, localePath(r.locale, r.path));
  const entries: MetadataRoute.Sitemap = [];
  const order = (l: Locale) => LOCALES.indexOf(l);
  for (const group of byPage.values()) {
    group.sort((a, b) => order(a.locale) - order(b.locale));
    const languages: Record<string, string> = {};
    for (const r of group) languages[r.locale] = url(r);
    for (const r of group) {
      entries.push({
        url: url(r),
        ...(r.publishedAt ? { lastModified: new Date(r.publishedAt).toISOString() } : {}),
        ...(group.length > 1 ? { alternates: { languages } } : {}),
      });
    }
  }
  entries.sort((a, b) => a.url.localeCompare(b.url));
  return entries;
}

/** Every live, indexable route (tag `site:sitemap`, recomputed outside a Next request). */
export async function getSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const load = async () => loadSitemapEntries(await getAppDb());
  const cached = unstable_cache(load, ["site:getSitemapEntries"], { tags: ["site:sitemap", "site:routes"], revalidate: 3600 });
  try {
    return await cached();
  } catch (error) {
    if (/incrementalCache missing|static generation store missing/i.test(String((error as Error)?.message ?? error))) return load();
    throw error;
  }
}

/** robots.txt: production allows the site but not the admin, api, portal and previews; other environments disallow everything. */
export function robotsFor(input: { isProduction: boolean; origin: string }): MetadataRoute.Robots {
  if (!input.isProduction) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/api", "/*/account", "/*/preview"] }],
    sitemap: absoluteUrl(input.origin, "/sitemap.xml"),
  };
}

/** Whether this deployment is production (`VERCEL_ENV = 'production'`). */
export function isProductionEnv(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "production";
}

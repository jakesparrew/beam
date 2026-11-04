import { localeFromSegment } from "@beam/core/i18n";
import { localePath } from "@beam/core/site";
import { getPublicSettings, listPosts } from "@/modules/site/queries";
import { absoluteUrl } from "@/modules/site/server/urls";

/** RSS 2.0 of the latest 20 posts in the locale (site spec section 4 route table). */
export const revalidate = 3600;

const FEED_SIZE = 20;

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export async function GET(_request: Request, context: { params: Promise<{ locale: string }> }): Promise<Response> {
  const locale = localeFromSegment((await context.params).locale);
  if (!locale) return new Response("Not found", { status: 404 });
  const [{ site, company }, posts] = await Promise.all([getPublicSettings(), listPosts(locale, { page: 1, limit: FEED_SIZE })]);
  const origin = site.canonical_origin.replace(/\/+$/, "");
  const home = absoluteUrl(origin, localePath(locale, ""));
  const self = absoluteUrl(origin, `${localePath(locale, "")}/feed.xml`);
  const title = company.trade_name ?? company.legal_name ?? "BEAM";
  const items = posts.items
    .map((p) => {
      const link = absoluteUrl(origin, p.href);
      return [
        "    <item>",
        `      <title>${xml(p.title)}</title>`,
        `      <link>${xml(link)}</link>`,
        `      <guid isPermaLink="false">${xml(p.pageId)}</guid>`,
        `      <pubDate>${new Date(p.publishedAt).toUTCString()}</pubDate>`,
        p.excerpt ? `      <description>${xml(p.excerpt)}</description>` : null,
        "    </item>",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${xml(title)}</title>`,
    `    <link>${xml(home)}</link>`,
    `    <description>${xml(title)}</description>`,
    `    <language>${xml(locale)}</language>`,
    `    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml" />`,
    posts.items[0] ? `    <lastBuildDate>${new Date(posts.items[0].publishedAt).toUTCString()}</lastBuildDate>` : null,
    items || null,
    "  </channel>",
    "</rss>",
  ]
    .filter(Boolean)
    .join("\n");
  return new Response(body, { headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=600" } });
}

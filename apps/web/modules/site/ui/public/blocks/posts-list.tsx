/** `posts_list` block: published posts newest first, with "Newer" / "Older" paging on `?page=n`. */
import { formatDate } from "@beam/core/i18n";
import type { BlockContext, BlockOf } from "../block-renderer";
import { MediaImage } from "../media-image";

export function PostsListBlockView({ block, ctx }: { block: BlockOf<"posts_list">; ctx: BlockContext }) {
  const { tr, locale } = ctx;
  const list = ctx.data.posts[block.id];
  const items = list?.items ?? [];
  const page = list?.page ?? 1;
  return (
    <div className="space-y-6">
      {block.heading ? <h2 className="text-2xl font-semibold">{block.heading}</h2> : null}
      {items.length === 0 ? (
        <p className="text-muted-foreground">{tr("site.blocks.posts.empty")}</p>
      ) : (
        <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((p) => (
            <li key={p.pageId} className="flex flex-col gap-3">
              {p.coverMediaId && ctx.data.media[p.coverMediaId] ? <MediaImage media={ctx.data.media[p.coverMediaId]} sizes="(min-width: 1024px) 320px, 100vw" /> : null}
              <h3 className="text-lg font-semibold">
                <a href={p.href} className="hover:underline">
                  {p.title}
                </a>
              </h3>
              <time dateTime={p.publishedAt} className="text-sm text-muted-foreground">
                {formatDate(p.publishedAt, locale, "long")}
              </time>
              {p.excerpt ? <p className="text-muted-foreground">{p.excerpt}</p> : null}
              <a href={p.href} className="text-sm font-medium underline" aria-label={`${tr("site.blocks.posts.readMore")}: ${p.title}`}>
                {tr("site.blocks.posts.readMore")}
              </a>
            </li>
          ))}
        </ul>
      )}
      {block.paginate && (page > 1 || list?.hasMore) ? (
        <nav className="flex justify-between text-sm" aria-label={block.heading ?? tr("site.blocks.posts.older")}>
          {page > 1 ? <a href={`${ctx.data.pagePath}?page=${page - 1}`}>{tr("site.blocks.posts.newer")}</a> : <span />}
          {list?.hasMore ? <a href={`${ctx.data.pagePath}?page=${page + 1}`}>{tr("site.blocks.posts.older")}</a> : null}
        </nav>
      ) : null}
    </div>
  );
}

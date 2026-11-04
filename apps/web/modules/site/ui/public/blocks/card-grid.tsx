/** `card_grid` block: 1-12 cards with heading, text, optional image and link. */
import { externalLinkRel } from "@beam/core/site";
import { linkHref } from "../../../queries/public";
import type { BlockContext, BlockOf } from "../block-renderer";
import { MediaImage } from "../media-image";

export function CardGridBlockView({ block, ctx }: { block: BlockOf<"card_grid">; ctx: BlockContext }) {
  return (
    <div className="space-y-6">
      {block.heading ? <h2 className="text-2xl font-semibold">{block.heading}</h2> : null}
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {block.cards.map((card, i) => {
          const href = card.link ? linkHref(card.link, ctx.locale, ctx.data.hrefs) : null;
          const media = card.mediaId ? ctx.data.media[card.mediaId] : undefined;
          return (
            <li key={i} className="flex flex-col gap-3 rounded-xl border border-border p-5">
              {media ? <MediaImage media={media} sizes="(min-width: 1024px) 320px, (min-width: 640px) 50vw, 100vw" /> : null}
              <h3 className="text-lg font-semibold">
                {href ? (
                  <a href={href} rel={externalLinkRel(href)} className="hover:underline">
                    {card.heading}
                  </a>
                ) : (
                  card.heading
                )}
              </h3>
              {card.text ? <p className="text-muted-foreground">{card.text}</p> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

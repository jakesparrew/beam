/** `hero` block: the page's single `h1` (rule 18), optional subheading, image and button. */
import { externalLinkRel } from "@beam/core/site";
import { linkHref } from "../../../queries/public";
import { buttonClass, type BlockContext, type BlockOf } from "../block-renderer";
import { MediaImage } from "../media-image";

export function HeroBlockView({ block, ctx, isFirst }: { block: BlockOf<"hero">; ctx: BlockContext; isFirst: boolean }) {
  const Heading = isFirst ? "h1" : "h2";
  const href = block.cta ? linkHref(block.cta.link, ctx.locale, ctx.data.hrefs) : null;
  const media = block.mediaId ? ctx.data.media[block.mediaId] : undefined;
  return (
    <div className="grid items-center gap-8 md:grid-cols-2">
      <div className="space-y-4">
        <Heading className="text-4xl font-bold tracking-tight sm:text-5xl">{block.heading}</Heading>
        {block.subheading ? <p className="text-lg text-muted-foreground">{block.subheading}</p> : null}
        {block.cta && href ? (
          <a href={href} rel={externalLinkRel(href)} className={buttonClass}>
            {block.cta.label}
          </a>
        ) : null}
      </div>
      {media ? <MediaImage media={media} priority sizes="(min-width: 768px) 50vw, 100vw" /> : null}
    </div>
  );
}

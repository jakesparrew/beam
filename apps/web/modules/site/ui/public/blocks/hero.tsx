/**
 * `hero` block: the page's single `h1` (rule 18), optional subheading, image and button. Rendered
 * as a full-bleed rounded panel: the photo (or the navy brand panel with a gold glow when there is
 * none) behind a navy gradient, the heading in Rufina and the gold pill. Generous bottom space so
 * quick-action tiles can overlap its lower edge.
 */
import { externalLinkRel } from "@beam/core/site";
import { linkHref } from "../../../queries/public";
import { ArrowBadge, goldButtonClass, type BlockContext, type BlockOf } from "../block-renderer";
import { MediaImage } from "../media-image";

export function HeroBlockView({ block, ctx, isFirst }: { block: BlockOf<"hero">; ctx: BlockContext; isFirst: boolean }) {
  const Heading = isFirst ? "h1" : "h2";
  const href = block.cta ? linkHref(block.cta.link, ctx.locale, ctx.data.hrefs) : null;
  const media = block.mediaId ? ctx.data.media[block.mediaId] : undefined;
  return (
    <div className="site-on-dark relative isolate flex min-h-[82vh] items-end overflow-hidden rounded-[2rem] bg-[#212842]">
      {media ? (
        <MediaImage media={media} priority sizes="100vw" className="absolute inset-0 -z-20 h-full w-full object-cover" />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-20 bg-[radial-gradient(60%_70%_at_85%_15%,rgba(209,166,74,0.55),transparent_60%),linear-gradient(160deg,#2b3354_0%,#212842_55%,#171c30_100%)]"
        />
      )}
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,rgba(23,28,48,0.88)_0%,rgba(23,28,48,0.55)_45%,rgba(23,28,48,0.1)_100%),linear-gradient(0deg,rgba(23,28,48,0.75)_0%,transparent_45%)]" />
      <div className="mx-auto w-full max-w-6xl space-y-7 px-6 pt-44 pb-36 sm:px-10 md:pb-44">
        <p className="text-xs font-semibold tracking-[0.35em] text-[#ffd76a] uppercase">BEAM Vitality Center</p>
        <Heading className="font-display max-w-3xl text-5xl leading-[1.02] text-[#fffaef] sm:text-6xl md:text-7xl">{block.heading}</Heading>
        {block.subheading ? <p className="max-w-xl text-lg leading-relaxed text-[#fffaef]/85">{block.subheading}</p> : null}
        {block.cta && href ? (
          <a href={href} rel={externalLinkRel(href)} className={`${goldButtonClass} py-2 pr-2 pl-7 text-base`}>
            {block.cta.label}
            <ArrowBadge dark />
          </a>
        ) : null}
      </div>
    </div>
  );
}

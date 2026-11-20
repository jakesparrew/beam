/** `cta` block: heading, text and one button on a navy band; the button is hidden when its page target is hidden. */
import { externalLinkRel } from "@beam/core/site";
import { linkHref } from "../../../queries/public";
import { ArrowBadge, goldButtonClass, type BlockContext, type BlockOf } from "../block-renderer";

export function CtaBlockView({ block, ctx }: { block: BlockOf<"cta">; ctx: BlockContext }) {
  const href = linkHref(block.button.link, ctx.locale, ctx.data.hrefs);
  return (
    <div className="site-on-dark relative isolate overflow-hidden rounded-[2rem] bg-[#212842] px-6 py-14 text-center sm:px-12">
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(50%_80%_at_50%_0%,rgba(209,166,74,0.35),transparent_70%)]" />
      <div className="mx-auto max-w-2xl space-y-5">
        <h2 className="font-display text-3xl sm:text-[2.8rem]">{block.heading}</h2>
        {block.text ? <p className="text-lg leading-relaxed text-muted-foreground">{block.text}</p> : null}
        {href ? (
          <a href={href} rel={externalLinkRel(href)} className={`${goldButtonClass} py-2 pr-2 pl-6 text-base`}>
            {block.button.label}
            <ArrowBadge dark />
          </a>
        ) : null}
      </div>
    </div>
  );
}

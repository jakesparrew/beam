/** `cta` block: heading, text and one button; the button is hidden when its page target is hidden. */
import { externalLinkRel } from "@beam/core/site";
import { linkHref } from "../../../queries/public";
import { buttonClass, type BlockContext, type BlockOf } from "../block-renderer";

export function CtaBlockView({ block, ctx }: { block: BlockOf<"cta">; ctx: BlockContext }) {
  const href = linkHref(block.button.link, ctx.locale, ctx.data.hrefs);
  return (
    <div className="space-y-4 rounded-xl bg-muted p-8 text-center">
      <h2 className="text-2xl font-semibold">{block.heading}</h2>
      {block.text ? <p className="text-muted-foreground">{block.text}</p> : null}
      {href ? (
        <a href={href} rel={externalLinkRel(href)} className={buttonClass}>
          {block.button.label}
        </a>
      ) : null}
    </div>
  );
}

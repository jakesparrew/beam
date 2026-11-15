/** `image_text` block: a tall rounded photo beside rich text, photo on the chosen side from `md` up. */
import type { BlockContext, BlockOf } from "../block-renderer";
import { MediaImage } from "../media-image";
import { RichText } from "../rich-text";

export function ImageTextBlockView({ block, ctx }: { block: BlockOf<"image_text">; ctx: BlockContext }) {
  const media = ctx.data.media[block.mediaId];
  return (
    <div className="grid items-center gap-10 md:grid-cols-12 md:gap-16">
      <div className={`site-zoom overflow-hidden rounded-[2rem] md:col-span-5 ${block.imageSide === "right" ? "md:order-2" : ""}`}>
        {media ? <MediaImage media={media} sizes="(min-width: 768px) 40vw, 100vw" className="aspect-[4/5] h-full w-full object-cover" /> : null}
      </div>
      <div className="md:col-span-7">
        <RichText doc={block.doc} />
      </div>
    </div>
  );
}

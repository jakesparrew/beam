/** `image_text` block: an image beside rich text, image on the chosen side from `md` up. */
import type { BlockContext, BlockOf } from "../block-renderer";
import { MediaImage } from "../media-image";
import { RichText } from "../rich-text";

export function ImageTextBlockView({ block, ctx }: { block: BlockOf<"image_text">; ctx: BlockContext }) {
  const media = ctx.data.media[block.mediaId];
  return (
    <div className="grid items-center gap-8 md:grid-cols-2">
      <div className={block.imageSide === "right" ? "md:order-2" : undefined}>{media ? <MediaImage media={media} sizes="(min-width: 768px) 50vw, 100vw" /> : null}</div>
      <RichText doc={block.doc} />
    </div>
  );
}

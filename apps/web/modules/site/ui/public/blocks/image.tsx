/** `image` block: a media-library image with its caption (block caption, else the media caption). */
import type { BlockContext, BlockOf } from "../block-renderer";
import { MediaImage } from "../media-image";

export function ImageBlockView({ block, ctx }: { block: BlockOf<"image">; ctx: BlockContext }) {
  const media = ctx.data.media[block.mediaId];
  if (!media) return null;
  const caption = block.caption ?? media.caption;
  return (
    <figure className="space-y-2">
      <MediaImage media={media} />
      {caption ? <figcaption className="text-sm text-muted-foreground">{caption}</figcaption> : null}
    </figure>
  );
}

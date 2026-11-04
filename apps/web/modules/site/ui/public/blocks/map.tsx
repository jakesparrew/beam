/** `map` block (rule 23): a static image linking to the map provider; no third-party iframe. */
import type { BlockContext, BlockOf } from "../block-renderer";
import { MediaImage } from "../media-image";

export function MapBlockView({ block, ctx }: { block: BlockOf<"map">; ctx: BlockContext }) {
  const media = ctx.data.media[block.mediaId];
  return (
    <figure className="space-y-2">
      {media ? (
        <a href={block.linkUrl} rel="noopener" className="block">
          <MediaImage media={media} />
        </a>
      ) : null}
      <a href={block.linkUrl} rel="noopener" className="text-sm font-medium underline">
        {ctx.tr("site.blocks.map.open")}
      </a>
    </figure>
  );
}

/**
 * A media-library image through `next/image` with its stored width and height (rule 51), served
 * by platform's `/api/public/files/[id]`. Decorative images get an empty `alt`.
 */
import Image from "next/image";
import type { PublicMedia } from "../../queries/public";

export function MediaImage({ media, className, sizes, priority }: { media: PublicMedia | undefined; className?: string; sizes?: string; priority?: boolean }) {
  if (!media) return null;
  return (
    <Image
      src={media.url}
      alt={media.decorative ? "" : media.alt}
      width={media.width}
      height={media.height}
      sizes={sizes ?? "(min-width: 1024px) 960px, 100vw"}
      className={className ?? "h-auto w-full rounded-lg object-cover"}
      priority={priority}
    />
  );
}

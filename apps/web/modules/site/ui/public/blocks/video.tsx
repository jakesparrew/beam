"use client";

/**
 * `video` block (rule 22): a click-to-load facade. Before the click the markup holds only the
 * media-library poster and a play button; nothing comes from Google. The click creates the
 * `youtube-nocookie.com` iframe and a "Watch on YouTube" fallback link.
 */
import { useState } from "react";
import type { PublicMedia } from "../../../queries/public";

export type VideoFacadeProps = {
  youtubeId: string;
  title: string;
  poster: PublicMedia | null;
  playLabel: string;
  consentNote: string;
  openLabel: string;
};

export function VideoFacade({ youtubeId, title, poster, playLabel, consentNote, openLabel }: VideoFacadeProps) {
  const [playing, setPlaying] = useState(false);
  if (playing) {
    return (
      <div className="space-y-2">
        <div className="relative aspect-video overflow-hidden rounded-xl">
          <iframe
            className="absolute inset-0 h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${youtubeId}?autoplay=1&rel=0`}
            title={title}
            allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        </div>
        <a href={`https://www.youtube.com/watch?v=${youtubeId}`} rel="noopener" className="text-sm underline">
          {openLabel}
        </a>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setPlaying(true)}
        className="group relative block aspect-video w-full overflow-hidden rounded-xl bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        aria-label={playLabel}
      >
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element -- poster from the media library, sized by its stored dimensions
          <img src={poster.url} alt="" width={poster.width} height={poster.height} className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
        ) : null}
        <span aria-hidden className="absolute inset-0 m-auto flex size-16 items-center justify-center rounded-full bg-black/70 text-2xl text-white group-hover:bg-black/85">
          ▶
        </span>
      </button>
      <p className="text-xs text-muted-foreground">{consentNote}</p>
    </div>
  );
}

/** The block's client part; `BlockRenderer` passes only serialisable props (labels resolved on the server). */
export const VideoBlockView = VideoFacade;

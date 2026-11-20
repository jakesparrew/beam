"use client";

/**
 * `video` block (rule 22): a click-to-load facade. Before the click the markup holds only the
 * media-library poster and a play button; nothing comes from Google. The click creates the
 * `youtube-nocookie.com` iframe and a "Watch on YouTube" fallback link. `portrait` is for a
 * vertical video (a YouTube Short): a tall 9:16 frame with rounded corners instead of 16:9.
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
  portrait?: boolean;
};

export function VideoFacade({ youtubeId, title, poster, playLabel, consentNote, openLabel, portrait = false }: VideoFacadeProps) {
  const [playing, setPlaying] = useState(false);
  const frame = portrait ? "aspect-[9/16] rounded-[2rem] shadow-[0_30px_60px_-30px_rgb(33_40_66/0.55)] ring-1 ring-[#eadfc6]" : "aspect-video rounded-xl";
  if (playing) {
    return (
      <div className="space-y-2">
        <div className={`relative overflow-hidden bg-[#171c30] ${frame}`}>
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
        className={`group relative block w-full overflow-hidden bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${frame}`}
        aria-label={playLabel}
      >
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element -- poster from the media library, sized by its stored dimensions
          <img src={poster.url} alt="" width={poster.width} height={poster.height} className="absolute inset-0 h-full w-full object-cover" loading="lazy" />
        ) : null}
        {portrait ? <span aria-hidden className="absolute inset-0 bg-[linear-gradient(0deg,rgba(23,28,48,0.55)_0%,rgba(23,28,48,0)_45%)]" /> : null}
        <span
          aria-hidden
          className={`absolute inset-0 m-auto flex items-center justify-center rounded-full text-2xl transition group-hover:scale-105 ${portrait ? "site-gold size-20 pl-1 text-[#212842]" : "size-16 bg-black/70 text-white group-hover:bg-black/85"}`}
        >
          ▶
        </span>
      </button>
      <p className="text-xs text-muted-foreground">{consentNote}</p>
    </div>
  );
}

/** The block's client part; `BlockRenderer` passes only serialisable props (labels resolved on the server). */
export const VideoBlockView = VideoFacade;

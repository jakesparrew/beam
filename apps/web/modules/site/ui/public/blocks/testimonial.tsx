/**
 * `testimonial` block (rule 21): a quote whose author agreed to be quoted (`consentConfirmed`).
 * Consecutive testimonials render as one Google-review section (`ReviewsView`): the Google mark,
 * the 5-star rating and the reviews in full as cards with name and date (`authorDetail`).
 */
import type { BlockOf, Tr } from "../block-renderer";

function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className}>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function Stars({ label }: { label: string }) {
  return (
    <span role="img" aria-label={label} className="text-base tracking-[0.15em] text-[#fbbc04]">
      ★★★★★
    </span>
  );
}

export function TestimonialBlockView({ block }: { block: BlockOf<"testimonial"> }) {
  return (
    <figure className="mx-auto max-w-3xl space-y-4 rounded-[2rem] bg-card p-8 shadow-sm">
      <blockquote className="font-display text-2xl leading-snug">
        <p>“{block.quote}”</p>
      </blockquote>
      <figcaption className="text-sm">
        <span className="font-semibold">{block.authorName}</span>
        {block.authorDetail ? <span className="text-muted-foreground"> · {block.authorDetail}</span> : null}
      </figcaption>
    </figure>
  );
}

/** One or more testimonials as a Google-review section. */
export function ReviewsView({ blocks, tr }: { blocks: BlockOf<"testimonial">[]; tr: Tr }) {
  const stars = tr("site.blocks.reviews.stars");
  return (
    <div className="space-y-10">
      <div className="flex flex-col items-start justify-between gap-6 md:flex-row md:items-end">
        <div className="max-w-2xl space-y-4">
          <p className="text-xs font-semibold tracking-[0.3em] text-[#a0621e] uppercase">{tr("site.blocks.reviews.eyebrow")}</p>
          <h2 className="font-display text-3xl leading-tight sm:text-4xl md:text-5xl">{tr("site.blocks.reviews.heading")}</h2>
          <p className="text-lg leading-relaxed text-muted-foreground">{tr("site.blocks.reviews.intro")}</p>
        </div>
        <div className="flex items-center gap-4 rounded-full border border-border bg-card px-5 py-3 shadow-sm">
          <GoogleMark className="size-8" />
          <div className="leading-tight">
            <p className="flex items-center gap-2 font-semibold">
              <span className="text-lg">5,0</span>
              <Stars label={stars} />
            </p>
            <p className="text-xs text-muted-foreground">{tr("site.blocks.reviews.source")}</p>
          </div>
        </div>
      </div>
      <ul className="columns-1 gap-4 md:columns-2 lg:columns-3">
        {blocks.map((b) => (
          <li key={b.id} className="mb-4 break-inside-avoid">
            <figure className="space-y-4 rounded-[1.75rem] border border-border bg-card p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <Stars label={stars} />
                <GoogleMark className="size-5" />
              </div>
              <blockquote className="leading-relaxed text-card-foreground">
                <p>{b.quote}</p>
              </blockquote>
              <figcaption className="flex items-center gap-3 border-t border-border pt-4">
                <span aria-hidden="true" className="inline-flex size-10 items-center justify-center rounded-full bg-[#212842] font-semibold text-[#ffd76a]">
                  {b.authorName.charAt(0).toUpperCase()}
                </span>
                <span className="leading-tight">
                  <span className="block font-semibold">{b.authorName}</span>
                  {b.authorDetail ? <span className="block text-xs text-muted-foreground">{b.authorDetail}</span> : null}
                </span>
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </div>
  );
}

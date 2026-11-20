/**
 * `card_grid` block: 1-12 cards with heading, text, optional image and link, in one of three
 * layouts (`layout`, default `cards`):
 * - `cards`: photo cards (image fills the card, text over a navy gradient); cards without a photo
 *   alternate white, sand and navy.
 * - `split`: two large panels side by side; the first in day style (light, sun), the second in
 *   night style (navy, moon and stars), each over its photo.
 * - `list`: a numbered editorial list (01, 02, ...) without card chrome.
 * - `icons`: white cards with a gold brand icon (`icon`, the line icons of beam.be) above the text.
 * A linked card is clickable as a whole (stretched link) with an arrow badge.
 */
import { externalLinkRel } from "@beam/core/site";
import { linkHref, type PublicMedia } from "../../../queries/public";
import { ArrowBadge, sectionHeadingClass, type BlockContext, type BlockOf } from "../block-renderer";
import { MediaImage } from "../media-image";

type Card = BlockOf<"card_grid">["cards"][number];

const TONES = ["bg-card border border-border", "bg-[#f4ead3]", "site-on-dark bg-[#212842]"] as const;

function CardLink({ href, children, className }: { href: string | null; children: React.ReactNode; className?: string }) {
  return href ? (
    <a href={href} rel={externalLinkRel(href)} className={`after:absolute after:inset-0 after:z-10 focus-visible:outline-2 focus-visible:outline-ring ${className ?? ""}`}>
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

function SunIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
    </svg>
  );
}

function SplitPanel({ card, href, media, night }: { card: Card; href: string | null; media: PublicMedia | undefined; night: boolean }) {
  return (
    <li className={`site-zoom relative isolate flex min-h-[30rem] flex-col justify-end overflow-hidden rounded-[2rem] p-8 sm:p-10 ${night ? "site-on-dark bg-[#171c30]" : "bg-[#f4ead3]"}`}>
      {media ? <MediaImage media={media} sizes="(min-width: 768px) 50vw, 100vw" className="absolute inset-0 -z-20 h-full w-full object-cover" /> : null}
      <div
        aria-hidden="true"
        className={`absolute inset-0 -z-10 ${night ? "bg-[linear-gradient(0deg,rgba(23,28,48,0.95)_15%,rgba(33,40,66,0.75)_55%,rgba(33,40,66,0.55)_100%)]" : "bg-[linear-gradient(0deg,rgba(255,250,239,0.98)_35%,rgba(255,250,239,0.82)_62%,rgba(255,250,239,0.05)_100%)]"}`}
      />
      {night ? (
        <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[radial-gradient(1px_1px_at_12%_18%,#fffaef,transparent),radial-gradient(1.5px_1.5px_at_32%_9%,#ffd76a,transparent),radial-gradient(1px_1px_at_58%_22%,#fffaef,transparent),radial-gradient(1px_1px_at_80%_12%,#fffaef,transparent),radial-gradient(1.5px_1.5px_at_90%_32%,#ffd76a,transparent),radial-gradient(1px_1px_at_45%_35%,#fffaef,transparent)]" />
      ) : null}
      <span className={`mb-auto inline-flex size-14 items-center justify-center rounded-full ${night ? "bg-[#fffaef]/10 text-[#ffd76a] ring-1 ring-[#ffd76a]/40" : "bg-[#fffaef] text-[#a0621e] shadow-sm"}`}>{night ? <MoonIcon /> : <SunIcon />}</span>
      <div className="mt-24 space-y-3">
        <h3 className={`font-display text-4xl sm:text-5xl ${night ? "text-[#fffaef]" : "text-[#212842]"}`}>
          <CardLink href={href}>{card.heading}</CardLink>
        </h3>
        {card.text ? <p className={`max-w-md text-base leading-relaxed ${night ? "text-[#fffaef]/80" : "text-[#4c5268]"}`}>{card.text}</p> : null}
      </div>
      {href ? (
        <span className="mt-6 flex">
          <ArrowBadge dark={!night} />
        </span>
      ) : null}
    </li>
  );
}

function PhotoCard({ card, href, media }: { card: Card; href: string | null; media: PublicMedia }) {
  return (
    <li className="site-zoom site-on-dark relative isolate flex min-h-[26rem] flex-col justify-end overflow-hidden rounded-[1.75rem] bg-[#212842] p-6">
      <MediaImage media={media} sizes="(min-width: 1024px) 380px, (min-width: 640px) 50vw, 100vw" className="absolute inset-0 -z-20 h-full w-full object-cover" />
      <div aria-hidden="true" className="absolute inset-0 -z-10 bg-[linear-gradient(0deg,rgba(23,28,48,0.95)_25%,rgba(23,28,48,0.6)_60%,rgba(23,28,48,0)_100%)]" />
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-2">
          <h3 className="text-xl font-semibold text-[#fffaef]">
            <CardLink href={href}>{card.heading}</CardLink>
          </h3>
          {card.text ? <p className="text-sm leading-relaxed text-[#fffaef]/80">{card.text}</p> : null}
        </div>
        {href ? <ArrowBadge /> : null}
      </div>
    </li>
  );
}

function ToneCard({ card, href, index }: { card: Card; href: string | null; index: number }) {
  const tone = TONES[index % TONES.length]!;
  const dark = tone.includes("site-on-dark");
  return (
    <li className={`relative flex flex-col gap-4 rounded-[1.75rem] p-6 transition hover:-translate-y-0.5 hover:shadow-md ${tone}`}>
      <h3 className="text-xl font-semibold">
        <CardLink href={href}>{card.heading}</CardLink>
      </h3>
      {card.text ? <p className="leading-relaxed text-muted-foreground">{card.text}</p> : null}
      {href ? (
        <span className="mt-auto flex justify-end pt-2">
          <ArrowBadge dark={!dark} />
        </span>
      ) : null}
    </li>
  );
}

export function CardGridBlockView({ block, ctx }: { block: BlockOf<"card_grid">; ctx: BlockContext }) {
  const layout = block.layout ?? "cards";
  const hrefOf = (card: Card) => (card.link ? linkHref(card.link, ctx.locale, ctx.data.hrefs) : null);
  const mediaOf = (card: Card) => (card.mediaId ? ctx.data.media[card.mediaId] : undefined);

  if (layout === "list") {
    return (
      <div className="grid gap-10 lg:grid-cols-12">
        {block.heading ? <h2 className={`${sectionHeadingClass} lg:col-span-4`}>{block.heading}</h2> : null}
        <ol className={`divide-y divide-border border-y border-border ${block.heading ? "lg:col-span-8" : "lg:col-span-12"}`}>
          {block.cards.map((card, i) => {
            const href = hrefOf(card);
            return (
              <li key={i} className="group relative grid grid-cols-[3.5rem_1fr_auto] items-start gap-4 py-7">
                <span className="font-display text-3xl leading-none text-[#a0621e]">{String(i + 1).padStart(2, "0")}</span>
                <div className="space-y-2">
                  <h3 className="text-xl font-semibold">
                    <CardLink href={href} className="group-hover:text-[#a0621e]">
                      {card.heading}
                    </CardLink>
                  </h3>
                  {card.text ? <p className="max-w-xl leading-relaxed text-muted-foreground">{card.text}</p> : null}
                </div>
                {href ? <ArrowBadge dark /> : <span />}
              </li>
            );
          })}
        </ol>
      </div>
    );
  }

  if (layout === "icons") {
    return (
      <div className="space-y-10">
        {block.heading ? <h2 className={`${sectionHeadingClass} max-w-3xl`}>{block.heading}</h2> : null}
        <ul className={`grid gap-4 sm:grid-cols-2 ${block.cards.length % 4 === 0 ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
          {block.cards.map((card, i) => {
            const href = hrefOf(card);
            return (
              <li key={i} className="relative flex flex-col gap-4 rounded-[1.75rem] border border-border bg-card p-7 transition hover:-translate-y-0.5 hover:shadow-md">
                {card.icon ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a static brand icon
                  <img src={`/brand/story/${card.icon}.svg`} alt="" width={64} height={64} loading="lazy" className="size-16" />
                ) : null}
                <h3 className="text-xl leading-snug font-semibold">
                  <CardLink href={href}>{card.heading}</CardLink>
                </h3>
                {card.text ? <p className="leading-relaxed text-muted-foreground">{card.text}</p> : null}
                {href ? (
                  <span className="mt-auto flex justify-end pt-2">
                    <ArrowBadge dark />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  if (layout === "split") {
    return (
      <div className="space-y-8">
        {block.heading ? <h2 className={`${sectionHeadingClass} px-1 text-center`}>{block.heading}</h2> : null}
        <ul className="grid gap-4 md:grid-cols-2">
          {block.cards.map((card, i) => (
            <SplitPanel key={i} card={card} href={hrefOf(card)} media={mediaOf(card)} night={i % 2 === 1} />
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {block.heading ? <h2 className={sectionHeadingClass}>{block.heading}</h2> : null}
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {block.cards.map((card, i) => {
          const media = mediaOf(card);
          return media ? <PhotoCard key={i} card={card} href={hrefOf(card)} media={media} /> : <ToneCard key={i} card={card} href={hrefOf(card)} index={i} />;
        })}
      </ul>
    </div>
  );
}

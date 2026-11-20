/**
 * Renders one locale's block list (site-P2). Every V1 block type of `@beam/core/site` has its
 * component in `blocks/`; the data they need was loaded beforehand by `loadRenderData`, so the
 * renderer is synchronous and pure. Exactly one `h1` per page (rule 18): the hero heading when
 * the first block is a hero, else the page title rendered by `PageView`; blocks use `h2`-`h4`.
 * `webinar_signup` (R2) renders webinar's `WebinarSignup` server component through
 * `WebinarSignupBlockView` of `./event-facts`.
 */
import type { ReactNode } from "react";
import type { Locale, MessageParams } from "@beam/core/i18n";
import type { Block } from "@beam/core/site";
import type { RenderData } from "../../server/render-data";
import { AvailabilityPreviewBlockView } from "./blocks/availability-preview";
import { BookingCtaBlockView, BookingCtaGroupView } from "./blocks/booking-cta";
import { CardGridBlockView } from "./blocks/card-grid";
import { ContactDetailsBlockView } from "./blocks/contact-details";
import { CtaBlockView } from "./blocks/cta";
import { EventsListBlockView } from "./blocks/events-list";
import { FaqBlockView } from "./blocks/faq";
import { FormEmbedBlockView } from "./blocks/form-embed";
import { HeroBlockView } from "./blocks/hero";
import { ImageBlockView } from "./blocks/image";
import { ImageTextBlockView } from "./blocks/image-text";
import { LegalMetaBlockView } from "./blocks/legal-meta";
import { MapBlockView } from "./blocks/map";
import { PostsListBlockView } from "./blocks/posts-list";
import { PricingTableBlockView } from "./blocks/pricing-table";
import { RichTextBlockView } from "./blocks/rich-text";
import { RichText } from "./rich-text";
import { ReviewsView, TestimonialBlockView } from "./blocks/testimonial";
import { VideoBlockView } from "./blocks/video";
import { WebinarSignupBlockView } from "./event-facts";

export type Tr = (key: string, params?: MessageParams) => string;

/** What every block component receives besides its block. */
export type BlockContext = { locale: Locale; tr: Tr; data: RenderData };

export type BlockOf<T extends Block["type"]> = Extract<Block, { type: T }>;

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

/** Shared button-like link styles (pill shapes; colours from the site tokens). */
export const buttonClass = `inline-flex items-center justify-center gap-2 rounded-[15px] bg-[#212842] px-7 py-4 text-[1.1rem] font-medium text-[#d1a64a] transition hover:opacity-90 ${focusRing}`;
export const secondaryButtonClass = `inline-flex items-center justify-center gap-2 rounded-[15px] bg-[#d1a64a] px-7 py-4 text-[1.1rem] font-medium text-[#212842] transition hover:opacity-90 ${focusRing}`;
/** The BEAM gold-gradient pill, for the main booking action (sweep and glow in globals.css `.site-gold`). */
export const goldButtonClass = `site-gold inline-flex items-center justify-center gap-2 rounded-full px-6 py-3 text-sm font-semibold tracking-wide text-[#212842] ${focusRing}`;
/** Section headings (h2) of every block. */
export const sectionHeadingClass = "font-display text-3xl text-foreground sm:text-4xl md:text-[2.8rem]";

/** The round arrow badge at the end of pills and cards. */
export function ArrowBadge({ dark = false }: { dark?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`site-arrow inline-flex size-8 shrink-0 items-center justify-center rounded-full text-base leading-none ${dark ? "bg-[#212842] text-[#fffaef]" : "bg-[#fffaef] text-[#212842]"}`}
    >
      →
    </span>
  );
}

function renderBlock(block: Block, ctx: BlockContext, index: number): ReactNode {
  switch (block.type) {
    case "hero":
      return <HeroBlockView block={block} ctx={ctx} isFirst={index === 0} />;
    case "rich_text":
      return <RichTextBlockView block={block} tr={ctx.tr} />;
    case "image":
      return <ImageBlockView block={block} ctx={ctx} />;
    case "image_text":
      return <ImageTextBlockView block={block} ctx={ctx} />;
    case "cta":
      return <CtaBlockView block={block} ctx={ctx} />;
    case "card_grid":
      return <CardGridBlockView block={block} ctx={ctx} />;
    case "faq":
      return <FaqBlockView block={block} />;
    case "pricing_table":
      return <PricingTableBlockView block={block} ctx={ctx} />;
    case "events_list":
      return <EventsListBlockView block={block} ctx={ctx} />;
    case "availability_preview":
      return <AvailabilityPreviewBlockView block={block} ctx={ctx} />;
    case "posts_list":
      return <PostsListBlockView block={block} ctx={ctx} />;
    case "form_embed":
      return <FormEmbedBlockView block={block} ctx={ctx} />;
    case "booking_cta":
      return <BookingCtaBlockView block={block} ctx={ctx} />;
    case "video": {
      const video = (
        <figure className={`space-y-2 ${block.portrait ? "mx-auto w-full max-w-[19rem]" : ""}`}>
          <VideoBlockView
            youtubeId={block.youtubeId}
            title={block.title}
            poster={ctx.data.media[block.posterMediaId] ?? null}
            playLabel={ctx.tr("site.blocks.video.play", { title: block.title })}
            consentNote={ctx.tr("site.blocks.video.consentNote")}
            openLabel={ctx.tr("site.blocks.video.openOnYoutube")}
            portrait={block.portrait ?? false}
          />
          <figcaption className="text-sm font-medium">{block.title}</figcaption>
        </figure>
      );
      // With text: the story on the left, the video beside it (under it on a phone).
      return block.doc ? (
        <div className="grid items-center gap-10 md:grid-cols-12 md:gap-16">
          <RichText doc={block.doc} className="site-story space-y-5 md:col-span-7" />
          <div className="md:col-span-5">{video}</div>
        </div>
      ) : (
        video
      );
    }
    case "testimonial":
      return <TestimonialBlockView block={block} />;
    case "contact_details":
      return <ContactDetailsBlockView block={block} ctx={ctx} />;
    case "map":
      return <MapBlockView block={block} ctx={ctx} />;
    case "legal_meta":
      return <LegalMetaBlockView ctx={ctx} />;
    case "webinar_signup":
      return <WebinarSignupBlockView block={block} ctx={ctx} />;
    default:
      return null;
  }
}

const SECTION_CLASS: Partial<Record<Block["type"], string>> = {
  hero: "w-full px-3 pt-3 sm:px-4",
};
const DEFAULT_SECTION_CLASS = "mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 md:py-16";

/** Consecutive `booking_cta` blocks render as one row of quick-action tiles, consecutive testimonials as one review section. */
type Group = { first: number; blocks: Block[] };
const GROUPED: ReadonlySet<Block["type"]> = new Set(["booking_cta", "testimonial"]);

function groupBlocks(blocks: readonly Block[]): Group[] {
  const groups: Group[] = [];
  blocks.forEach((block, i) => {
    const last = groups.at(-1);
    if (GROUPED.has(block.type) && last && last.blocks.at(-1)?.type === block.type) last.blocks.push(block);
    else groups.push({ first: i, blocks: [block] });
  });
  return groups;
}

export function BlockRenderer({ blocks, ctx }: { blocks: readonly Block[]; ctx: BlockContext }) {
  return (
    <>
      {groupBlocks(blocks).map(({ first, blocks: group }) => {
        const block = group[0]!;
        const afterHero = first > 0 && blocks[first - 1]?.type === "hero";
        if (block.type === "testimonial") {
          return (
            <section key={block.id} data-block="testimonial" className={DEFAULT_SECTION_CLASS}>
              <ReviewsView blocks={group as BlockOf<"testimonial">[]} tr={ctx.tr} />
            </section>
          );
        }
        if (group.length > 1) {
          // Quick actions right under the hero overlap its lower edge.
          const cls = afterHero ? "relative z-10 mx-auto -mt-24 w-full max-w-6xl px-4 pb-10 sm:px-6 md:-mt-28" : DEFAULT_SECTION_CLASS;
          return (
            <section key={block.id} data-block="booking_cta" className={cls}>
              <BookingCtaGroupView blocks={group as BlockOf<"booking_cta">[]} ctx={ctx} />
            </section>
          );
        }
        const variant = block.type === "rich_text" ? block.variant : undefined;
        const wide = (block.type === "card_grid" && block.layout === "split") || variant === "statement";
        return (
          <section key={block.id} data-block={block.type} data-variant={variant} className={wide ? "mx-auto w-full max-w-7xl px-3 py-10 sm:px-4 md:py-16" : (SECTION_CLASS[block.type] ?? DEFAULT_SECTION_CLASS)}>
            {renderBlock(block, ctx, first)}
          </section>
        );
      })}
    </>
  );
}

/** Whether the page's h1 comes from its first block (rule 18). */
export function heroIsH1(blocks: readonly Block[]): boolean {
  return blocks[0]?.type === "hero";
}

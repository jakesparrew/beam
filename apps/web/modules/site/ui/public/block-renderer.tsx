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
import { BookingCtaBlockView } from "./blocks/booking-cta";
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
import { TestimonialBlockView } from "./blocks/testimonial";
import { VideoBlockView } from "./blocks/video";
import { WebinarSignupBlockView } from "./event-facts";

export type Tr = (key: string, params?: MessageParams) => string;

/** What every block component receives besides its block. */
export type BlockContext = { locale: Locale; tr: Tr; data: RenderData };

export type BlockOf<T extends Block["type"]> = Extract<Block, { type: T }>;

/** Shared button-like link style (tokens from `packages/ui`). */
export const buttonClass =
  "inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
export const secondaryButtonClass =
  "inline-flex items-center justify-center rounded-md border border-border px-5 py-2.5 text-sm font-semibold hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function renderBlock(block: Block, ctx: BlockContext, index: number): ReactNode {
  switch (block.type) {
    case "hero":
      return <HeroBlockView block={block} ctx={ctx} isFirst={index === 0} />;
    case "rich_text":
      return <RichTextBlockView block={block} />;
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
    case "video":
      return (
        <figure className="space-y-2">
          <VideoBlockView
            youtubeId={block.youtubeId}
            title={block.title}
            poster={ctx.data.media[block.posterMediaId] ?? null}
            playLabel={ctx.tr("site.blocks.video.play", { title: block.title })}
            consentNote={ctx.tr("site.blocks.video.consentNote")}
            openLabel={ctx.tr("site.blocks.video.openOnYoutube")}
          />
          <figcaption className="text-sm font-medium">{block.title}</figcaption>
        </figure>
      );
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

export function BlockRenderer({ blocks, ctx }: { blocks: readonly Block[]; ctx: BlockContext }) {
  return (
    <>
      {blocks.map((block, i) => (
        <section key={block.id} data-block={block.type} className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
          {renderBlock(block, ctx, i)}
        </section>
      ))}
    </>
  );
}

/** Whether the page's h1 comes from its first block (rule 18). */
export function heroIsH1(blocks: readonly Block[]): boolean {
  return blocks[0]?.type === "hero";
}

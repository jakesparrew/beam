/**
 * Page blocks (site spec section 4, rules 17-23): the allowed types defined once, each with a
 * strict Zod schema. Blocks are stored per locale (`page_versions.blocks[locale]`); every text
 * inside a locale's list is a plain string in that locale.
 */
import { z } from "zod";
import { LOCALES, type Locale } from "../i18n";
import { LinkSchema, SafeHref, type Link } from "./links";
import { RichDocSchema, type RichDoc } from "./rich-text";

export const MAX_BLOCKS = 60;

export const BLOCK_TYPES = [
  "hero",
  "rich_text",
  "image",
  "image_text",
  "cta",
  "card_grid",
  "faq",
  "pricing_table",
  "events_list",
  "availability_preview",
  "posts_list",
  "form_embed",
  "booking_cta",
  "video",
  "testimonial",
  "contact_details",
  "map",
  "legal_meta",
  "webinar_signup",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

const uuid = z.string().uuid();
const line = (max: number) => z.string().trim().min(1).max(max);
const optLine = (max: number) => z.string().trim().max(max).optional();

const Button = z.object({ label: line(60), link: LinkSchema }).strict();

export const HeroBlock = z
  .object({ id: uuid, type: z.literal("hero"), heading: line(120), subheading: optLine(300), mediaId: uuid.optional(), cta: Button.optional() })
  .strict();
export const RichTextBlock = z.object({ id: uuid, type: z.literal("rich_text"), doc: RichDocSchema }).strict();
export const ImageBlock = z.object({ id: uuid, type: z.literal("image"), mediaId: uuid, caption: optLine(300) }).strict();
export const ImageTextBlock = z
  .object({ id: uuid, type: z.literal("image_text"), mediaId: uuid, doc: RichDocSchema, imageSide: z.enum(["left", "right"]) })
  .strict();
export const CtaBlock = z.object({ id: uuid, type: z.literal("cta"), heading: line(120), text: optLine(500), button: Button }).strict();
export const CardGridBlock = z
  .object({
    id: uuid,
    type: z.literal("card_grid"),
    heading: optLine(120),
    cards: z.array(z.object({ heading: line(120), text: z.string().trim().max(500), mediaId: uuid.optional(), link: LinkSchema.optional() }).strict()).min(1).max(12),
  })
  .strict();
export const FaqBlock = z
  .object({
    id: uuid,
    type: z.literal("faq"),
    heading: optLine(120),
    items: z.array(z.object({ question: line(300), answer: RichDocSchema }).strict()).min(1).max(30),
  })
  .strict();
export const PricingTableBlock = z
  .object({ id: uuid, type: z.literal("pricing_table"), heading: optLine(120), productIds: z.array(uuid).min(1).max(12), showMemberPrice: z.boolean() })
  .strict();
export const EventsListBlock = z
  .object({ id: uuid, type: z.literal("events_list"), heading: optLine(120), limit: z.number().int().min(1).max(24), showFull: z.boolean() })
  .strict();
export const AvailabilityPreviewBlock = z
  .object({ id: uuid, type: z.literal("availability_preview"), kind: z.enum(["day", "night"]), days: z.number().int().min(1).max(14) })
  .strict();
export const PostsListBlock = z
  .object({ id: uuid, type: z.literal("posts_list"), heading: optLine(120), limit: z.number().int().min(1).max(24), paginate: z.boolean() })
  .strict();
export const FormEmbedBlock = z
  .object({ id: uuid, type: z.literal("form_embed"), formSlug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(80) })
  .strict();
export const BookingCtaTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("book_day") }).strict(),
  z.object({ kind: z.literal("book_night") }).strict(),
  z.object({ kind: z.literal("session"), sessionId: uuid }).strict(),
  z.object({ kind: z.literal("buy_product"), productId: uuid }).strict(),
  z.object({ kind: z.literal("gift") }).strict(),
]);
export const BookingCtaBlock = z.object({ id: uuid, type: z.literal("booking_cta"), label: line(60), target: BookingCtaTarget }).strict();
export const VideoBlock = z
  .object({ id: uuid, type: z.literal("video"), youtubeId: z.string().regex(/^[A-Za-z0-9_-]{11}$/), title: line(200), posterMediaId: uuid })
  .strict();
export const TestimonialBlock = z
  .object({
    id: uuid,
    type: z.literal("testimonial"),
    quote: line(1000),
    authorName: line(120),
    authorDetail: optLine(120),
    consentConfirmed: z.literal(true),
  })
  .strict();
export const ContactDetailsBlock = z
  .object({
    id: uuid,
    type: z.literal("contact_details"),
    showAddress: z.boolean(),
    showPhone: z.boolean(),
    showEmail: z.boolean(),
    showOpeningHours: z.boolean(),
  })
  .strict();
export const MapBlock = z
  .object({ id: uuid, type: z.literal("map"), mediaId: uuid, linkUrl: SafeHref.refine((h) => h.startsWith("https://"), { message: "map link must be https" }) })
  .strict();
export const LegalMetaBlock = z.object({ id: uuid, type: z.literal("legal_meta") }).strict();
export const WebinarSignupBlock = z.object({ id: uuid, type: z.literal("webinar_signup"), webinarId: uuid }).strict();

export const BlockSchema = z.discriminatedUnion("type", [
  HeroBlock,
  RichTextBlock,
  ImageBlock,
  ImageTextBlock,
  CtaBlock,
  CardGridBlock,
  FaqBlock,
  PricingTableBlock,
  EventsListBlock,
  AvailabilityPreviewBlock,
  PostsListBlock,
  FormEmbedBlock,
  BookingCtaBlock,
  VideoBlock,
  TestimonialBlock,
  ContactDetailsBlock,
  MapBlock,
  LegalMetaBlock,
  WebinarSignupBlock,
]);

type Base = { id: string };
export type BookingCtaTargetValue =
  | { kind: "book_day" }
  | { kind: "book_night" }
  | { kind: "session"; sessionId: string }
  | { kind: "buy_product"; productId: string }
  | { kind: "gift" };
export type Block =
  | (Base & { type: "hero"; heading: string; subheading?: string; mediaId?: string; cta?: { label: string; link: Link } })
  | (Base & { type: "rich_text"; doc: RichDoc })
  | (Base & { type: "image"; mediaId: string; caption?: string })
  | (Base & { type: "image_text"; mediaId: string; doc: RichDoc; imageSide: "left" | "right" })
  | (Base & { type: "cta"; heading: string; text?: string; button: { label: string; link: Link } })
  | (Base & { type: "card_grid"; heading?: string; cards: { heading: string; text: string; mediaId?: string; link?: Link }[] })
  | (Base & { type: "faq"; heading?: string; items: { question: string; answer: RichDoc }[] })
  | (Base & { type: "pricing_table"; heading?: string; productIds: string[]; showMemberPrice: boolean })
  | (Base & { type: "events_list"; heading?: string; limit: number; showFull: boolean })
  | (Base & { type: "availability_preview"; kind: "day" | "night"; days: number })
  | (Base & { type: "posts_list"; heading?: string; limit: number; paginate: boolean })
  | (Base & { type: "form_embed"; formSlug: string })
  | (Base & { type: "booking_cta"; label: string; target: BookingCtaTargetValue })
  | (Base & { type: "video"; youtubeId: string; title: string; posterMediaId: string })
  | (Base & { type: "testimonial"; quote: string; authorName: string; authorDetail?: string; consentConfirmed: true })
  | (Base & { type: "contact_details"; showAddress: boolean; showPhone: boolean; showEmail: boolean; showOpeningHours: boolean })
  | (Base & { type: "map"; mediaId: string; linkUrl: string })
  | (Base & { type: "legal_meta" })
  | (Base & { type: "webinar_signup"; webinarId: string });

/** One locale's block list: at most 60 blocks, unique ids, `hero` only as the first block (rule 18). */
export const BlockList = z
  .array(BlockSchema)
  .max(MAX_BLOCKS)
  .superRefine((blocks, ctx) => {
    const seen = new Set<string>();
    blocks.forEach((b, i) => {
      if (seen.has(b.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "duplicate block id" });
      seen.add(b.id);
      if (b.type === "hero" && i > 0) ctx.addIssue({ code: "custom", path: [i, "type"], message: "hero is allowed only as the first block" });
    });
  });

/** `page_versions.blocks`: one block list per locale. Validated on every write. */
export const BlocksByLocale = z.object({ "nl-BE": BlockList.optional(), "fr-BE": BlockList.optional(), en: BlockList.optional() }).strict();
export type BlocksByLocale = Partial<Record<Locale, Block[]>>;

export class BlockValidationError extends Error {
  readonly code = "validation";
  constructor(
    readonly locale: Locale,
    readonly issues: { path: (string | number)[]; message: string }[],
  ) {
    super(`invalid blocks for ${locale}: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    this.name = "BlockValidationError";
  }
}

/** Parses one locale's block list or throws `BlockValidationError`. */
export function parseBlocks(locale: Locale, json: unknown): Block[] {
  const parsed = BlockList.safeParse(json);
  if (!parsed.success) {
    throw new BlockValidationError(
      locale,
      parsed.error.issues.map((i) => ({ path: i.path.map((p) => (typeof p === "symbol" ? String(p) : p)), message: i.message })),
    );
  }
  return parsed.data;
}

/** Parses every locale's list (`BlocksByLocale`). */
export function parseBlocksByLocale(json: unknown): BlocksByLocale {
  const value = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  const extra = Object.keys(value).filter((k) => !(LOCALES as readonly string[]).includes(k));
  if (extra.length) throw new BlockValidationError("en", [{ path: extra, message: "unknown locale key" }]);
  const out: BlocksByLocale = {};
  for (const l of LOCALES) if (value[l] !== undefined) out[l] = parseBlocks(l, value[l]);
  return out;
}

/** The single `h1` of a page (rule 18): the hero heading when the first block is a hero, else the title. */
export function pageH1(blocks: readonly Block[] | undefined, title: string): string {
  const first = blocks?.[0];
  return first?.type === "hero" ? first.heading : title;
}

/**
 * `@beam/email/blocks`: the block document compiler (email-P2). Block document -> MJML -> HTML
 * and plain text per locale and dynamic variant, personalisation, accessibility checks.
 */
export {
  compileMarketing,
  compileDocument,
  selectVariant,
  variantChoices,
  encodeVariant,
  decodeVariant,
  mjmlToHtml,
  CompileError,
  DEFAULT_VARIANT,
  MAX_HTML_BYTES,
  type VariantPath,
  type VariantRecipient,
  type PersonStatus,
  type CompileContext,
  type CompileResult,
  type CompiledVariant,
  type MjmlIssue,
} from "./compile";
export { personalise, tokenNames, type TokenValues, type PersonaliseOptions } from "./personalise";
export {
  checkAccessibility,
  checkHtmlAccessibility,
  isVagueLinkText,
  VAGUE_LINK_TEXTS,
  MIN_WORDS_WITH_IMAGES,
  type Warning,
  type WarningCode,
} from "./a11y";
export {
  blocksToMjml,
  expandBlocks,
  cardRefs,
  EMPTY_CARDS,
  IMAGE_BASE_URL,
  SHOP_BASE_URL,
  type ProductCard,
  type EventCard,
  type ResolvedCards,
  type ResolveCards,
  type CardRefs,
  type VariantChoice,
  type ToMjmlContext,
} from "./to-mjml";
export { blocksToText, type ToTextContext } from "./to-text";
export { markdownToHtml, markdownToText, markdownLinks, countWords, escapeKeepingTokens, type MarkdownLink } from "./markdown";

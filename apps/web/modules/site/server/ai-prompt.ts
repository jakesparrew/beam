/**
 * The prompt of `site.propose_page` (site rules 42-44, decision 22; site-P4). Claude receives the
 * base version's content, the staff instruction, the block schema, the brand voice from
 * `settings.site.brand_voice` and reference lists (product ids and names, upcoming event session
 * ids and titles, form slugs, page ids and titles), each capped at 200 items. It never receives
 * personal data: no requester, no persons, no emails or phone numbers from the database. The
 * system prompt is stable (no per-call text), so the client's `cache_control` reads the cache.
 */
import type { ClaudeMessage } from "@/lib/ai";
import { LOCALES, type Locale, type LocalizedText } from "@beam/core/i18n";
import type { LegalKey, PageKind, VersionContent } from "@beam/core/site";

export type AiMessage = ClaudeMessage;

/** Rule 42: what `ai_requests.fields_sent` documents for a proposal (no personal data). */
export const PROPOSAL_FIELDS_SENT = ["page_content", "instruction", "catalogue_refs"] as const;

/** Each reference list holds at most this many items. */
export const REF_LIST_CAP = 200;

export type ProposalRefs = {
  products: { id: string; name: LocalizedText | string }[];
  sessions: { id: string; title: LocalizedText | string; startsAt?: string }[];
  forms: { slug: string; name: LocalizedText | string }[];
  pages: { id: string; title: LocalizedText | string; kind?: PageKind }[];
};

export type ProposalPromptInput = {
  page: { kind: PageKind; legalKey: LegalKey | null; sessionId: string | null; slug: string };
  base: VersionContent | null;
  instruction: string;
  locales: readonly Locale[];
  refs: ProposalRefs;
  brandVoice: string;
  /** `edit` (default) changes the base; `new_page` writes the page from the instruction. */
  kind?: "edit" | "new_page";
};

const BLOCK_SCHEMA = `Block types (every block has "id": a UUID, and "type"):
- hero: heading (<=120), subheading?, mediaId?, cta? { label, link }. Only as the first block.
- rich_text: doc (rich text document: { type: "doc", content: [paragraph | heading(level 2|3) | bulletList | orderedList | blockquote] }).
- image: mediaId, caption?.  image_text: mediaId, doc, imageSide "left"|"right".
- cta: heading, text?, button { label, link }.
- card_grid: heading?, cards (1-12) { heading, text, mediaId?, link? }.
- faq: heading?, items (1-30) { question, answer (rich text doc) }.
- pricing_table: heading?, productIds (1-12, from the product list), showMemberPrice.
- events_list: heading?, limit 1-24, showFull.  availability_preview: kind "day"|"night", days 1-14.
- posts_list: heading?, limit 1-24, paginate.  form_embed: formSlug (from the form list).
- booking_cta: label, target { kind: "book_day"|"book_night"|"gift" } | { kind: "session", sessionId } | { kind: "buy_product", productId }.
- video: youtubeId (11 chars), title, posterMediaId.  testimonial: quote, authorName, authorDetail?, consentConfirmed true.
- contact_details: showAddress, showPhone, showEmail, showOpeningHours.  map: mediaId, linkUrl (https).
- legal_meta (legal pages only).  webinar_signup: webinarId.
A link is { kind: "page", pageId } | { kind: "url", href } | { kind: "portal", route }.`;

const RULES = `Rules:
1. Answer only with JSON matching the output schema: title, paths, blocks, seo (per locale), excerpt?, changeSummary (<=500 chars, English, what you changed).
2. Keep the "id" of every block you keep or change. A new block gets a new random UUID. Never reuse an id for a block of another type.
3. Keep every locale of the base version; fill the requested target locales. Write real Dutch (nl-BE), French (fr-BE) and English (en), never placeholders.
4. You cannot change the page kind, legal key or linked session; do not output them.
5. Prices come from the catalogue: use a pricing_table block, never write amounts in text.
6. Reference only ids and slugs from the reference lists or the base content. Images: only media ids already in the base content.
7. Paths are lower-case words joined by hyphens (at most 3 segments); the home page path is "". Keep paths unless the instruction asks to change them.
8. Never add personal data (names, email addresses, phone numbers) that is not already in the base content or the instruction.`;

const SYSTEM = `You edit pages of the BEAM Vitality Center website (Belgium). You receive the current page content as JSON, a staff instruction, the brand voice and reference lists, and you return a complete new version of the page.

${BLOCK_SCHEMA}

${RULES}`;

const text = (v: LocalizedText | string): LocalizedText | string => (typeof v === "string" ? v : Object.fromEntries(LOCALES.filter((l) => v[l]).map((l) => [l, v[l]])));

/** The reference lists, each capped at `REF_LIST_CAP` items and reduced to ids, slugs and names. */
export function capRefs(refs: ProposalRefs): ProposalRefs {
  return {
    products: refs.products.slice(0, REF_LIST_CAP).map((p) => ({ id: p.id, name: text(p.name) })),
    sessions: refs.sessions.slice(0, REF_LIST_CAP).map((s) => ({ id: s.id, title: text(s.title), ...(s.startsAt ? { startsAt: s.startsAt } : {}) })),
    forms: refs.forms.slice(0, REF_LIST_CAP).map((f) => ({ slug: f.slug, name: text(f.name) })),
    pages: refs.pages.slice(0, REF_LIST_CAP).map((p) => ({ id: p.id, title: text(p.title), ...(p.kind ? { kind: p.kind } : {}) })),
  };
}

/** The base content sent to Claude (content fields only; no author, dates or user ids). */
function baseContent(base: VersionContent | null) {
  if (!base) return null;
  return { title: base.title, paths: base.paths, blocks: base.blocks, seo: base.seo, excerpt: base.excerpt ?? null, locales: base.locales };
}

export function buildProposalPrompt(input: ProposalPromptInput): { system: string; messages: AiMessage[]; fieldsSent: string[] } {
  const targets = LOCALES.filter((l) => input.locales.includes(l));
  const payload = {
    task: input.kind === "new_page" ? "write_new_page" : "edit_page",
    page: { kind: input.page.kind, legalKey: input.page.legalKey, hasLinkedSession: !!input.page.sessionId, isHome: input.page.kind === "home" },
    targetLocales: targets,
    brandVoice: input.brandVoice.trim() || null,
    base: baseContent(input.base),
    references: capRefs(input.refs),
  };
  const user = `Page and references (JSON):\n${JSON.stringify(payload)}\n\nInstruction from the staff member:\n${input.instruction.trim()}`;
  return { system: SYSTEM, messages: [{ role: "user", content: user }], fieldsSent: [...PROPOSAL_FIELDS_SENT] };
}

/**
 * The one repair round (rule 43): the original conversation, Claude's previous answer when it was
 * readable, and the validation errors to fix.
 */
export function buildRepairMessages(messages: readonly AiMessage[], previous: string | null, errors: readonly string[]): AiMessage[] {
  const list = errors.slice(0, 30).map((e) => `- ${e}`).join("\n");
  const ask = `Your answer was not a valid page proposal:\n${list}\n\nReturn the complete corrected proposal as JSON only, following every rule.`;
  return [...messages, ...(previous ? [{ role: "assistant" as const, content: previous }] : []), { role: "user", content: ask }];
}

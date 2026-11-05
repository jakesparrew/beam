/**
 * R4 AI campaign drafts (email spec sections 4 and 6, decision 47), email-P10: the output schema
 * of the `ai.draft_email` job and the prompt builder. Pure: no database, no provider.
 *
 * - `AiCampaignDraftSchema` (`AiCampaignDraft`): subject, preheader and block document in all
 *   three locales, a segment suggestion, a suggested send time with its rationale, and notes.
 *   The document uses only blocks the model can fill without ids it cannot know: heading, text,
 *   button, divider, spacer and event blocks of the chosen sessions (`draftDocumentIssues`).
 * - `buildDraftPrompt(input)`: the system and user prompt from brand settings, the last sent
 *   campaigns of the purpose (subjects, preheaders, Dutch plain text, open and click rates),
 *   session cards, segment names and counts, aggregate data of the chosen segment, the purpose,
 *   the locale list and the staff brief. `fieldsSent` names exactly the context keys present.
 *   No person-level value exists in any input type: drafts are built from aggregates only.
 */
import { z } from "zod";
import { LOCALES, type Locale } from "../i18n/locales";
import { completeLocalizedText, type LocalizedText } from "../i18n/localized-text";
import { BlockDocumentSchema, validateDocument, walkBlocks, type BlockDocument } from "./blocks";
import type { MarketingPurpose } from "./types";

/** The locales every AI draft must fill (no fallback language). */
export const AI_DRAFT_LOCALES: readonly Locale[] = LOCALES;

/** Block types an AI draft may use (no image, product or webinar: their ids are unknown to it). */
export const AI_DRAFT_BLOCK_TYPES = ["heading", "text", "button", "divider", "spacer", "event"] as const;

/** At most this many sessions per draft (the action accepts 0 to 3). */
export const AI_DRAFT_MAX_SESSIONS = 3;
/** The last sent campaigns of the same purpose shown to the model. */
export const AI_DRAFT_PREVIOUS_CAMPAIGNS = 5;
/** Plain text of one previous campaign in the prompt. */
export const AI_DRAFT_PREVIOUS_TEXT_MAX_CHARS = 2_000;
/** Segments listed in the prompt. */
export const AI_DRAFT_MAX_SEGMENTS = 50;

export const AiCampaignDraftSchema = z
  .object({
    subject: completeLocalizedText(AI_DRAFT_LOCALES),
    preheader: completeLocalizedText(AI_DRAFT_LOCALES),
    document: BlockDocumentSchema,
    segment: z.object({ segmentId: z.string().uuid().nullable(), description: z.string().max(1000) }).strict(),
    suggestedSendAt: z.iso.datetime({ offset: true }),
    timingRationale: z.string().max(2000),
    notes: z.string().max(4000),
  })
  .strict()
  .superRefine((draft, ctx) => {
    for (const l of AI_DRAFT_LOCALES) {
      if (!(draft.document.locales[l]?.length ?? 0)) ctx.addIssue({ code: "custom", path: ["document", "locales", l], message: `missing ${l}` });
    }
    const checked = validateDocument(draft.document);
    if (!checked.ok) for (const issue of checked.issues) ctx.addIssue({ code: "custom", path: ["document", ...issue.path], message: issue.message });
    for (const l of AI_DRAFT_LOCALES) {
      if ((draft.subject[l]?.length ?? 0) > 150) ctx.addIssue({ code: "custom", path: ["subject", l], message: "subject longer than 150 characters" });
      if ((draft.preheader[l]?.length ?? 0) > 200) ctx.addIssue({ code: "custom", path: ["preheader", l], message: "preheader longer than 200 characters" });
    }
  });

export type AiCampaignDraft = z.infer<typeof AiCampaignDraftSchema>;

/**
 * Problems of a parsed draft against the request: block types outside `AI_DRAFT_BLOCK_TYPES`
 * and event blocks of sessions that were not chosen. Empty when the draft may be stored.
 */
export function draftDocumentIssues(document: BlockDocument, sessionIds: readonly string[]): string[] {
  const issues: string[] = [];
  const allowed = new Set<string>(AI_DRAFT_BLOCK_TYPES);
  for (const l of AI_DRAFT_LOCALES) {
    walkBlocks((document.locales[l] ?? []), (block) => {
      if (!allowed.has(block.type)) issues.push(`${l}: block type ${block.type} not allowed`);
      else if (block.type === "event" && !sessionIds.includes(block.sessionId)) issues.push(`${l}: event ${block.sessionId} was not chosen`);
    });
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Prompt input (aggregates only)
// ---------------------------------------------------------------------------

/** `settings.email_brand`. */
export type DraftBrand = { tone_of_voice: string; guidelines: string; do_not_say: readonly string[]; sample_phrases: readonly LocalizedText[] };

export type DraftPreviousCampaign = {
  name: string;
  subject: string;
  preheader: string;
  /** The `nl-BE` plain text of the sent version. */
  text: string;
  sentAt: Date | null;
  /** Fractions 0..1 (`v_campaign_stats` or the frozen snapshot). */
  openRate: number | null;
  clickRate: number | null;
};

export type DraftSession = {
  sessionId: string;
  /** Per locale (the session card of each locale that has a title). */
  title: LocalizedText;
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  isMemberOnly: boolean;
  isLeadMagnet: boolean;
  availabilityBand: string;
};

export type DraftSegmentSummary = { id: string; name: string; description: string | null; count: number | null };

/** Aggregate data of the chosen segment: counts only, never a member. */
export type DraftSegmentAggregate = {
  id: string;
  name: string;
  total: number;
  byStatus: Record<"lead" | "customer" | "member", number>;
  byLocale: Record<Locale, number>;
  medianDaysSinceLastVisit: number | null;
};

export type DraftSegments = { list: readonly DraftSegmentSummary[]; chosen: DraftSegmentAggregate | null };

export type DraftPromptInput = {
  brand: DraftBrand;
  previousCampaigns: readonly DraftPreviousCampaign[];
  sessions: readonly DraftSession[];
  segments: DraftSegments;
  purpose: MarketingPurpose;
  brief: string;
  /** The request time, so the suggested send time lies in the future (defaults to none). */
  now?: Date;
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
const pct = (r: number | null) => (r === null ? null : Math.round(r * 1000) / 10);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

const LOCALE_NAMES: Record<Locale, string> = { "nl-BE": "Dutch (Belgium)", "fr-BE": "French (Belgium)", en: "English" };

/** The context object sent to the model; every key is a non-personal aggregate or brand field. */
function draftContext(input: DraftPromptInput): Record<string, unknown> {
  const ctx: Record<string, unknown> = {
    purpose: input.purpose,
    locales: [...AI_DRAFT_LOCALES],
    brief: input.brief,
    brand: {
      tone_of_voice: input.brand.tone_of_voice,
      guidelines: input.brand.guidelines,
      do_not_say: [...input.brand.do_not_say],
      sample_phrases: input.brand.sample_phrases.map((p) => ({ ...p })),
    },
  };
  if (input.now) ctx.request_date = input.now.toISOString();
  if (input.previousCampaigns.length) {
    ctx.previous_campaigns = input.previousCampaigns.slice(0, AI_DRAFT_PREVIOUS_CAMPAIGNS).map((c) => ({
      name: c.name,
      subject: c.subject,
      preheader: c.preheader,
      text_nl: clip(c.text, AI_DRAFT_PREVIOUS_TEXT_MAX_CHARS),
      sent_at: iso(c.sentAt),
      open_rate_pct: pct(c.openRate),
      click_rate_pct: pct(c.clickRate),
    }));
  }
  if (input.sessions.length) {
    ctx.sessions = input.sessions.slice(0, AI_DRAFT_MAX_SESSIONS).map((s) => ({
      session_id: s.sessionId,
      title: { ...s.title },
      starts_at: s.startsAt.toISOString(),
      ends_at: s.endsAt.toISOString(),
      location: s.location,
      is_member_only: s.isMemberOnly,
      is_lead_magnet: s.isLeadMagnet,
      availability: s.availabilityBand,
    }));
  }
  if (input.segments.list.length) {
    ctx.segments = input.segments.list.slice(0, AI_DRAFT_MAX_SEGMENTS).map((s) => ({ segment_id: s.id, name: s.name, description: s.description, count: s.count }));
  }
  if (input.segments.chosen) {
    const c = input.segments.chosen;
    ctx.chosen_segment = {
      segment_id: c.id,
      name: c.name,
      count: c.total,
      count_by_commercial_status: { ...c.byStatus },
      count_by_language: { ...c.byLocale },
      median_days_since_visit: c.medianDaysSinceLastVisit,
    };
  }
  return ctx;
}

/** Dotted key paths of a context value (`a.b`, arrays as `a[].b`); leaf paths only. */
export function contextKeys(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    const keys = new Set<string>();
    for (const item of value) for (const k of contextKeys(item, `${prefix}[]`)) keys.add(k);
    return keys.size ? [...keys] : prefix ? [prefix] : [];
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: string[] = [];
    for (const [k, v] of Object.entries(value)) out.push(...contextKeys(v, prefix ? `${prefix}.${k}` : k));
    return out;
  }
  return prefix ? [prefix] : [];
}

const SYSTEM = (locales: readonly Locale[]) =>
  [
    "You draft marketing email campaigns for BEAM Vitality Center, a health and fitness centre in Belgium.",
    "Staff review, edit and approve every draft; nothing you write is sent or scheduled without them.",
    `Write the subject, the preheader and the body in every one of these languages: ${locales.map((l) => `${l} (${LOCALE_NAMES[l]})`).join(", ")}. Each language is a natural rewrite for its readers, not a word-for-word translation. No language may be missing.`,
    "Follow the brand tone of voice and guidelines in the context. Never use a phrase from the do-not-say list.",
    "You only see aggregate figures. Do not address a named person and do not invent personal details, prices, discounts, dates or facts that are not in the context.",
    "Health claims are not allowed: no promises of medical results.",
    "Return a JSON object with: subject, preheader (objects with one string per language key), document, segment, suggestedSendAt, timingRationale, notes.",
    'document is { "schemaVersion": 1, "locales": { "<language>": Block[] } } with 2 to 12 blocks per language.',
    "Allowed blocks (each id is a unique 10-character string of letters, digits, - or _):",
    '- { "id", "type": "heading", "level": 1 | 2 | 3, "text" }',
    '- { "id", "type": "text", "markdown" } (short paragraphs; markdown links must be https)',
    '- { "id", "type": "button", "label", "href", "style": "primary" | "secondary" } (href is an https URL from the context, or {{book_url}})',
    '- { "id", "type": "divider" } and { "id", "type": "spacer", "height": 8..64 }',
    '- { "id", "type": "event", "sessionId", "ctaLabel" } only for a session_id listed in the context',
    "No image, product, webinar, columns or dynamic blocks. Do not write the footer or an unsubscribe line: the system adds them.",
    "segment: { segmentId: one segment_id from the context or null, description: who the campaign is for and why }.",
    "suggestedSendAt: an ISO 8601 date-time with offset, in the future, on a weekday between 08:00 and 21:00 Europe/Brussels, and before any session it promotes.",
    "timingRationale: one or two sentences. notes: anything staff should check before sending.",
  ].join("\n");

/** The prompt of one AI draft (email spec section 6). */
export function buildDraftPrompt(input: DraftPromptInput): { system: string; user: string; fieldsSent: string[] } {
  const context = draftContext(input);
  const fieldsSent = contextKeys(context).sort();
  const user = [
    "Context (JSON, aggregates and brand settings only):",
    JSON.stringify(context, null, 2),
    "",
    "Brief from staff:",
    input.brief.trim(),
  ].join("\n");
  return { system: SYSTEM(AI_DRAFT_LOCALES), user, fieldsSent };
}

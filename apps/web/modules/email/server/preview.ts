/**
 * Template preview (email spec rules 18, 19, 21, 23, 24; screen `/admin/templates/[id]/preview`),
 * email-P5.
 *
 * - `samplePersona(kind, outcome?)`: the Lead, Customer and Member samples of "Preview as" and of
 *   test sends: a status, an optional assessment outcome key (applied to every form slug the
 *   document's dynamic blocks select on) and fixed token values. No row is read.
 * - `personRecipient(tx, personId, ...)`: a real contact: `v_person_status`, the latest outcome
 *   per form through `forms.listLatestOutcomes` and the token values of `buildTokenValues()`,
 *   which read only names, status, credits, the next booking and merge fields (rule 24): no
 *   sensitive field is ever read.
 * - `resolveCardsFor(tx, locale)`: product and event cards through `commerce.getProductCards`,
 *   `booking.getSessionCards` and `site.getEventPageUrl` (rule 19), shared with publish.
 * - `buildPreview(tx, input)`: subject, preheader, HTML, text, size and warnings of one locale of
 *   the draft or current version. Block-backed versions compile on the fly (MJML strict), so the
 *   preview shows exactly what publish would store; code-backed versions render the registry
 *   component with its `sample` props and the edited copy.
 */
import type { DbOrTx } from "@beam/db";
import { persons, vPersonStatus } from "@beam/db/schema";
import { MissingTranslationError, NotImplementedError, PermanentError } from "@beam/core/errors";
import type { BlockDocument, MarketingPurpose, SamplePersona } from "@beam/core/email";
import { URL_SEGMENT, type Locale, type LocalizedText } from "@beam/core/i18n";
import { buildFooter, type FooterParts } from "@beam/email";
import {
  compileMarketing,
  personalise,
  selectVariant,
  tokenNames,
  type EventCard,
  type PersonStatus,
  type ProductCard,
  type ResolveCards,
  type TokenValues,
  type VariantPath,
  type Warning,
} from "@beam/email/blocks";
import { renderEmail, type CopyOverrides } from "@beam/email/render";
import { eq } from "@/lib/ctx";
import { getSessionCards } from "@/modules/booking/api";
import { getProductCards } from "@/modules/commerce/api";
import { listLatestOutcomes } from "@/modules/forms/api";
import { getEventPageUrl } from "@/modules/site/api";
import { consentDateOf, legalLinksFor, loadSendSettings, type SendSettings } from "./context";
import { appOrigin, buildTokenValues } from "./merge-fields";
import { assessmentFormSlugs } from "./send";
import { registryTemplate, type TemplateRow, type VersionRow } from "./templates-info";

/** The facts a preview or a test send renders for: a sample persona or a real contact. */
export type RecipientContext = {
  source: "sample" | "person";
  personId: string | null;
  /** `lead`, `customer` or `member` (`v_person_status`); null when the person has no status row. */
  status: PersonStatus | null;
  /** Sample only: the outcome key every assessment condition sees. */
  assessmentOutcome: string | null;
  /** Person only: the latest completed outcome key per form slug. */
  outcomes: Record<string, string | null>;
  /** Token values that do not depend on the locale. */
  values: Record<string, string | null>;
  /** Dates formatted per locale into `next_booking_at` and `membership_period_end_on`. */
  dates: { nextBookingAt: Date | null; membershipPeriodEnd: Date | null };
};

const SAMPLE_NAMES: Record<SamplePersona, { first: string; last: string; credits: string | null }> = {
  lead: { first: "Lena", last: "Peeters", credits: null },
  customer: { first: "Chris", last: "Janssens", credits: "2" },
  member: { first: "Mia", last: "Maes", credits: "8" },
};

const DAY_MS = 86_400_000;

/** A sample persona (no row is read). `outcome` is the assessment outcome key the dynamic blocks see. */
export function samplePersona(kind: SamplePersona, outcome?: string): RecipientContext {
  const n = SAMPLE_NAMES[kind];
  const now = Date.now();
  return {
    source: "sample",
    personId: null,
    status: kind,
    assessmentOutcome: outcome?.trim() || null,
    outcomes: {},
    values: { first_name: n.first, last_name: n.last, full_name: `${n.first} ${n.last}`, status: kind, credits_remaining: n.credits },
    dates: {
      nextBookingAt: kind === "lead" ? null : new Date(Math.ceil((now + 7 * DAY_MS) / 3_600_000) * 3_600_000),
      membershipPeriodEnd: kind === "member" ? new Date(now + 30 * DAY_MS) : null,
    },
  };
}

/** The recipient facts `selectVariant()` reads for `doc` in `locale`. */
export function variantRecipientOf(recipient: RecipientContext, doc: BlockDocument | null | undefined, locale: Locale): { status: PersonStatus | null; outcomes: Record<string, string | null> } {
  if (recipient.source === "person") return { status: recipient.status, outcomes: recipient.outcomes };
  const outcomes: Record<string, string | null> = {};
  for (const slug of assessmentFormSlugs(doc, locale)) outcomes[slug] = recipient.assessmentOutcome;
  return { status: recipient.status, outcomes };
}

/** A real contact: status, outcomes for the document's forms and the person's id (token values are read at render). */
export async function personRecipient(tx: DbOrTx, personId: string, doc: BlockDocument | null | undefined, locale: Locale): Promise<RecipientContext | null> {
  const [p] = await tx.select({ id: persons.id, erasedAt: persons.erasedAt }).from(persons).where(eq(persons.id, personId));
  if (!p || p.erasedAt) return null;
  const [s] = await tx.select({ status: vPersonStatus.status }).from(vPersonStatus).where(eq(vPersonStatus.personId, personId));
  const outcomes: Record<string, string | null> = {};
  for (const slug of assessmentFormSlugs(doc, locale)) outcomes[slug] = (await listLatestOutcomes(tx, [personId], slug)).get(personId) ?? null;
  const status = s?.status === "lead" || s?.status === "customer" || s?.status === "member" ? s.status : null;
  return { source: "person", personId, status, assessmentOutcome: null, outcomes, values: {}, dates: { nextBookingAt: null, membershipPeriodEnd: null } };
}

/** Placeholder crm links of a preview (the real ones carry the message's link token). */
export function previewLinks(locale: Locale): { preferencesUrl: string; unsubscribeUrl: string } {
  const base = `${appOrigin()}/${URL_SEGMENT[locale]}/preferences/preview`;
  return { preferencesUrl: base, unsubscribeUrl: `${base}?unsubscribe=1` };
}

/** The token values of one recipient in `locale` for the names used. */
export async function recipientTokenValues(tx: DbOrTx, recipient: RecipientContext, locale: Locale, names: readonly string[]): Promise<TokenValues> {
  const links = previewLinks(locale);
  if (recipient.source === "person" && recipient.personId) {
    return buildTokenValues(tx, { personId: recipient.personId, locale, context: null, names, links });
  }
  const fmtDate = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "long" });
  const fmtDateTime = new Intl.DateTimeFormat(locale, { timeZone: "Europe/Brussels", dateStyle: "long", timeStyle: "short" });
  const base = await buildTokenValues(tx, { personId: null, locale, context: null, names, links });
  return {
    ...base,
    ...recipient.values,
    next_booking_at: recipient.dates.nextBookingAt ? fmtDateTime.format(recipient.dates.nextBookingAt) : null,
    membership_period_end_on: recipient.dates.membershipPeriodEnd ? fmtDate.format(recipient.dates.membershipPeriodEnd) : null,
  };
}

/** Product and event cards of a document (rule 19), through the owning modules' read functions. */
export function resolveCardsFor(tx: DbOrTx, locale: Locale, now: Date = new Date()): ResolveCards {
  return async (refs) => {
    const products: Record<string, ProductCard> = {};
    const events: Record<string, EventCard> = {};
    try {
      for (const c of await getProductCards(tx, refs.productIds, locale)) {
        products[c.productId] = { id: c.productId, name: c.name, sku: c.sku, priceCents: c.priceCents, active: true, imageUrl: c.imageUrl };
      }
    } catch (error) {
      if (!(error instanceof NotImplementedError)) throw error;
    }
    try {
      for (const s of await getSessionCards(tx, refs.sessionIds, locale)) {
        let url: string | null = null;
        try {
          url = await getEventPageUrl(tx, s.sessionId, locale);
        } catch (error) {
          if (!(error instanceof NotImplementedError)) throw error;
        }
        const startsAt = new Date(s.startsAt);
        events[s.sessionId] = { id: s.sessionId, title: s.title, startsAt, url: url ?? `${appOrigin()}${s.bookUrl}`, active: startsAt.getTime() > now.getTime() };
      }
    } catch (error) {
      if (!(error instanceof NotImplementedError)) throw error;
    }
    return { products, events };
  };
}

/** A warning of the editor and the preview: the renderer's warnings plus the module's own. */
export type PreviewWarning = Warning | { code: "footer_incomplete" | "missing_translation" | "image_too_large" | "compile_error"; locale: Locale; blockId?: string; detail?: string };

/** The legal footer for a template preview or a compile; null (with a reason) when settings are incomplete. */
export async function templateFooter(
  tx: DbOrTx,
  input: { settings?: SendSettings; locale: Locale; purpose: MarketingPurpose | "transactional"; personId: string | null; links: { preferencesUrl: string; unsubscribeUrl: string | null } | null },
): Promise<{ footer: FooterParts | null; problem: "footer_incomplete" | "missing_translation" | null }> {
  const settings = input.settings ?? (await loadSendSettings(tx));
  const legalLinks = await legalLinksFor(input.locale, tx);
  const consentDate = input.purpose === "transactional" ? null : await consentDateOf(tx, input.personId, input.purpose);
  try {
    const footer = buildFooter({
      company: settings.company,
      footerSettings: settings.footer,
      legalLinks,
      purpose: input.purpose,
      consentDate,
      preferenceUrls: input.links,
      locale: input.locale,
    });
    return { footer, problem: null };
  } catch (error) {
    if (error instanceof MissingTranslationError) return { footer: null, problem: "missing_translation" };
    if (error instanceof PermanentError) return { footer: null, problem: "footer_incomplete" };
    throw error;
  }
}

export type PreviewResult = {
  subject: string;
  preheader: string;
  html: string;
  text: string;
  sizeBytes: number;
  warnings: PreviewWarning[];
  /** The dynamic variant path rendered (`default` without dynamic blocks; code-backed: `default`). */
  variant: VariantPath;
};

const EMPTY_FOOTER: FooterParts = { html: "", text: "" };
const textOf = (t: LocalizedText | null | undefined, locale: Locale) => (t?.[locale] ?? "").trim();

/**
 * Renders one locale of a version for a recipient. A missing translation gives an empty preview
 * with a `missing_translation` warning; an MJML error a `compile_error` warning.
 */
export async function buildPreview(
  tx: DbOrTx,
  input: { template: Pick<TemplateRow, "kind" | "purpose" | "slug">; version: VersionRow; locale: Locale; recipient: RecipientContext; now?: Date },
): Promise<PreviewResult> {
  const { template, version, locale, recipient } = input;
  const warnings: PreviewWarning[] = [];
  const purpose: MarketingPurpose | "transactional" = template.kind === "marketing" && template.purpose ? template.purpose : "transactional";
  const links = previewLinks(locale);
  const { footer, problem } = await templateFooter(tx, {
    locale,
    purpose,
    personId: recipient.personId,
    links: purpose === "transactional" ? { preferencesUrl: links.preferencesUrl, unsubscribeUrl: null } : links,
  });
  if (problem) warnings.push({ code: problem === "missing_translation" ? "missing_translation" : "footer_incomplete", locale });
  const subjectRaw = textOf(version.subject, locale);
  const preheaderRaw = textOf(version.preheader, locale);
  const empty = (extra: PreviewWarning[]): PreviewResult => ({ subject: subjectRaw, preheader: preheaderRaw, html: "", text: "", sizeBytes: 0, warnings: [...warnings, ...extra], variant: "default" });

  let html: string;
  let text: string;
  let subject = subjectRaw;
  let variant: VariantPath = "default";
  try {
    if (version.reactComponent) {
      const def = registryTemplate(version.reactComponent);
      if (!def) return empty([{ code: "compile_error", locale, detail: "unknown_template" }]);
      const copy = (version.copy ?? undefined) as CopyOverrides | undefined;
      const r = await renderEmail({ source: "code", template: def, locale, props: def.sample, ...(copy ? { copy } : {}), footer });
      ({ html, text, subject } = r);
    } else {
      const doc = version.document;
      if (!doc) return empty([{ code: "missing_translation", locale }]);
      const compiled = await compileMarketing(doc, locale, {
        footer: footer ?? EMPTY_FOOTER,
        resolveCards: resolveCardsFor(tx, locale, input.now),
        ...(subjectRaw ? { subject: subjectRaw } : {}),
        ...(preheaderRaw ? { preheader: preheaderRaw } : {}),
      });
      warnings.push(...compiled.warnings);
      variant = selectVariant(doc, locale, variantRecipientOf(recipient, doc, locale));
      const chosen = compiled.variants[variant] ?? Object.values(compiled.variants)[0];
      html = chosen?.html ?? "";
      text = chosen?.text ?? "";
    }
  } catch (error) {
    if (error instanceof MissingTranslationError) return empty([{ code: "missing_translation", locale }]);
    if (error instanceof PermanentError) return empty([{ code: "compile_error", locale, detail: error.message.slice(0, 300) }]);
    throw error;
  }

  const names = tokenNames(`${subject}\n${preheaderRaw}\n${html}\n${text}`);
  const values = await recipientTokenValues(tx, recipient, locale, [...names.tokens, ...names.mergeFields]);
  const out = {
    subject: personalise(subject, values, { escape: false }).trim(),
    preheader: personalise(preheaderRaw, values, { escape: false }).trim(),
    html: personalise(html, values, { escape: true }),
    text: personalise(text, values, { escape: false }).trim(),
  };
  return { ...out, sizeBytes: Buffer.byteLength(out.html, "utf8"), warnings, variant };
}

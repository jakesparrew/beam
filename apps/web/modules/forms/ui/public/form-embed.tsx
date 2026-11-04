/**
 * `FormEmbed({ slug, locale, context })` (forms spec section 4 "Cross-module API", rule A1): the
 * server component site renders inside its `form_embed` blocks and footer. It renders the same
 * public renderer inline (same origin) with the site context signed into `embedContext` (HMAC,
 * key info `beam-forms-embed`): `pagePath`, `landingPath`, `referrer`, `partnerCompanyId` and
 * `utm`. The start route trusts only a valid signature. No referral code is part of the context
 * (site rule 63). An unknown, unpublished, archived or unavailable-locale form renders nothing,
 * so a site page never breaks on a form.
 */
import type { FormEmbedProps } from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { getAppDb } from "@/lib/ctx";
import { messageTemplate } from "@/lib/i18n";
import { reportError } from "@/lib/logger";
import { getPublishedForm } from "../../service/public-queries";
import { signEmbedContext, type EmbedContext } from "../../service/tokens";
import { FormRenderer } from "./form-renderer";
import type { PublicLabels } from "./field-inputs";

/** The keys of `forms.public.*` the renderer reads. */
export const PUBLIC_LABEL_KEYS = [
  "start", "next", "back", "submit", "required", "required_mark", "optional_mark", "invalid", "invalid_option", "too_few", "too_many",
  "too_long", "number_range", "invalid_number", "invalid_email", "invalid_phone", "invalid_date", "guardian_required", "guardian_consent",
  "pending_confirmation", "staff_banner", "guest_confirmed", "staff_expired", "prefill_summary", "not_you", "saving", "retrying", "retry",
  "failed", "rate_limited", "error_summary", "progress", "closed_title", "resume_offer", "resume_continue", "resume_restart", "yes", "no",
  "choose", "rating_value", "honeypot", "view_result", "redirecting",
] as const;

/** The renderer's labels in one locale (raw templates: the client fills `{n}`, `{firstName}`, ...). */
export function publicLabels(locale: Locale): PublicLabels {
  return Object.fromEntries(PUBLIC_LABEL_KEYS.map((k) => [k, messageTemplate(locale, `forms.public.${k}`)]));
}

/** The signed context, or null when it does not validate (for example a malformed partner id). */
export function embedContextFor(context: FormEmbedProps["context"]): string | null {
  const c: EmbedContext = {
    pagePath: context.pagePath,
    ...(context.landingPath ? { landingPath: context.landingPath } : {}),
    ...(context.referrer ? { referrer: context.referrer } : {}),
    ...(context.partnerCompanyId ? { partnerCompanyId: context.partnerCompanyId } : {}),
    ...(context.utm && Object.keys(context.utm).length ? { utm: context.utm } : {}),
  };
  try {
    return signEmbedContext(c);
  } catch {
    return null;
  }
}

export async function FormEmbed({ slug, locale, context }: FormEmbedProps) {
  let form: Awaited<ReturnType<typeof getPublishedForm>>;
  try {
    form = await getPublishedForm(await getAppDb(), slug, locale);
  } catch (error) {
    reportError(error, { tags: { module: "forms", step: "form_embed", form_slug: slug } });
    return null;
  }
  if (!form || "closed" in form || "unavailableLocale" in form) return null;
  return (
    <FormRenderer
      slug={form.slug}
      kind={form.kind}
      locale={locale}
      definition={form.definition}
      scoring={form.scoring}
      labels={publicLabels(locale)}
      mode="inline"
      embedContext={embedContextFor(context)}
    />
  );
}

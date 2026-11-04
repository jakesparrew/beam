/**
 * The hosted form `/[locale]/f/[slug]` (forms spec section 5 "Public"). States: unknown slug or no
 * published version -> the "form not available" page (`not-found.tsx`, 404); archived -> "This
 * form is closed"; a locale outside the version's locales -> "This form is not available in your
 * language" with links to the available locales (never a mixed page). The first section renders
 * server-side. A customer session or a valid `?pt=` identity token prefills (ID2: only first
 * name, masked email and the known field keys reach the browser); a staff-entry token shows the
 * staff banner (ID10). `?embed=1` hides the site header and footer for the embed iframe and posts
 * its height to the parent. The page may be framed by any site (`frame-ancestors *`, platform's
 * `buildCsp`).
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LOCALES, localeFromSegment, URL_SEGMENT, type Locale } from "@beam/core/i18n";
import { LocaleUnavailable } from "@beam/ui";
import { actorFromSession, getSession } from "@/lib/auth";
import { getAppDb } from "@/lib/ctx";
import { translator } from "@/lib/i18n";
import { reportError } from "@/lib/logger";
import { buildPrefill, tokenFor } from "@/modules/forms/service/identity";
import { getPublishedForm } from "@/modules/forms/service/public-queries";
import { Markdown } from "@/modules/forms/ui/public/field-inputs";
import { publicLabels } from "@/modules/forms/ui/public/form-embed";
import { FormRenderer, type PublicPrefill } from "@/modules/forms/ui/public/form-renderer";

export const dynamic = "force-dynamic";

type Params = Promise<{ locale: string; slug: string }>;
type Search = Promise<Record<string, string | string[] | undefined>>;

const LANGUAGE: Record<Locale, string> = { "nl-BE": "Nederlands", "fr-BE": "Français", en: "English" };
/** `?embed=1`: the site chrome of the (site) layout is hidden inside the embed iframe. */
const EMBED_CSS = 'div:has(> #main-content) > header, div:has(> #main-content) > footer, div:has(> #main-content) > a[href="#main-content"] { display: none !important; } #main-content { padding: 0 !important; }';

function flatQuery(sp: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(sp).slice(0, 40)) {
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value === "string" && k.length <= 40) out[k] = value.slice(0, 1000);
  }
  return out;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale: seg, slug } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) return {};
  try {
    const form = await getPublishedForm(await getAppDb(), slug, locale);
    if (form && "definition" in form) return { title: form.definition.title[locale] };
  } catch {
    // The page itself reports the failure.
  }
  return {};
}

export default async function HostedFormPage({ params, searchParams }: { params: Params; searchParams: Search }) {
  const { locale: seg, slug } = await params;
  const locale = localeFromSegment(seg);
  if (!locale) notFound();
  const query = flatQuery(await searchParams);
  const embed = query.embed === "1";
  const tr = translator(locale);
  const db = await getAppDb();
  const form = await getPublishedForm(db, slug, locale);
  if (!form) notFound();

  const chrome = embed ? <style>{EMBED_CSS}</style> : null;
  if ("closed" in form) {
    return (
      <div className="mx-auto max-w-xl space-y-3 px-4 py-16 text-center" data-form-state="closed">
        {chrome}
        <h1 className="text-3xl font-bold">{tr("forms.public.closed_title")}</h1>
        <p className="text-muted-foreground">{tr("forms.public.closed_body")}</p>
      </div>
    );
  }
  if ("unavailableLocale" in form) {
    const qs = new URLSearchParams(query).toString();
    return (
      <div className="mx-auto max-w-xl px-4 py-16" data-form-state="unavailable-locale">
        {chrome}
        <LocaleUnavailable
          title={tr("forms.public.unavailable_locale_title")}
          description={tr("forms.public.unavailable_locale_body")}
          alternatives={LOCALES.filter((l) => form.locales.includes(l)).map((l) => ({
            locale: l,
            label: LANGUAGE[l],
            href: `/${URL_SEGMENT[l]}/f/${slug}${qs ? `?${qs}` : ""}`,
          }))}
        />
      </div>
    );
  }

  // ID1 and ID2: a customer session, else a valid identity token for this form.
  let personId: string | null = null;
  let staffEntry = false;
  let identityToken: string | null = null;
  try {
    const actor = actorFromSession(await getSession());
    if (actor?.kind === "customer") personId = actor.personId;
  } catch {
    // No session: the public visitor.
  }
  const claims = !personId && query.pt ? tokenFor(query.pt, slug, new Date()) : null;
  if (claims && (!claims.staffUserId || form.definition.settings.staffEntryAllowed)) {
    personId = claims.personId;
    staffEntry = !!claims.staffUserId;
    identityToken = query.pt ?? null;
  }
  let prefill: PublicPrefill | null = null;
  if (personId) {
    try {
      const p = await buildPrefill(db, form.definition, personId);
      prefill = { firstName: p.firstName, maskedEmail: p.maskedEmail, known: p.known };
    } catch (error) {
      reportError(error, { tags: { module: "forms", step: "prefill", form_slug: slug } });
    }
  }

  const intro = form.definition.intro?.[locale];
  return (
    <div className={embed ? "px-4 py-4" : "mx-auto max-w-2xl space-y-6 px-4 py-10 sm:px-6"} data-form-slug={slug}>
      {chrome}
      <header className="mb-6 space-y-3">
        <h1 className="text-3xl font-bold">{form.definition.title[locale]}</h1>
        {intro ? <Markdown text={intro} className="space-y-2 text-muted-foreground" /> : null}
      </header>
      <FormRenderer
        slug={slug}
        kind={form.kind}
        locale={locale}
        definition={form.definition}
        scoring={form.scoring}
        labels={publicLabels(locale)}
        mode={embed ? "embed" : "page"}
        query={query}
        identityToken={identityToken}
        prefill={prefill}
        staffFirstName={staffEntry ? prefill?.firstName || "…" : null}
      />
    </div>
  );
}

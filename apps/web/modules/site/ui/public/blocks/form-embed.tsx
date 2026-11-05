/**
 * `form_embed` block: forms' `FormEmbed` server component with the page path, the landing path
 * and the request's UTM parameters (rule 40, blueprint 16), and from R3 the partner company of a
 * partner landing page (`pages.partner_company_id`, only for pages of kind `landing`; site-P9),
 * which forms signs into the embed context and stamps on the lead. A failure of the forms module
 * hides the block and is reported; the page still renders.
 */
import type { ReactNode } from "react";
import { unstable_cache } from "next/cache";
import type { DbOrTx } from "@beam/db";
import { pageRoutes, pages } from "@beam/db/schema";
import type { FormEmbedProps, UtmParams } from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { localePath } from "@beam/core/site";
import { and, eq, getAppDb } from "@/lib/ctx";
import { FormEmbed } from "@/modules/forms/api";
import { reportBlockError } from "../../../server/render-data";
import type { BlockContext, BlockOf } from "../block-renderer";

/** Renders forms' `FormEmbed`, isolating a throwing or rejecting embed. */
export function SafeFormEmbed(props: FormEmbedProps): ReactNode {
  try {
    const out = (FormEmbed as (p: FormEmbedProps) => unknown)(props);
    if (out && typeof (out as Promise<unknown>).then === "function") {
      return (out as Promise<ReactNode>).catch((error: unknown) => {
        reportBlockError(error, "form_embed", { slug: props.slug });
        return null;
      }) as unknown as ReactNode;
    }
    return out as ReactNode;
  } catch (error) {
    reportBlockError(error, "form_embed", { slug: props.slug });
    return null;
  }
}

export function formEmbedProps(slug: string, locale: Locale, pagePath: string, utm: UtmParams, partnerCompanyId?: string | null): FormEmbedProps {
  return {
    slug,
    locale,
    context: { pagePath, landingPath: pagePath, ...(Object.keys(utm).length ? { utm } : {}), ...(partnerCompanyId ? { partnerCompanyId } : {}) },
  };
}

/**
 * The partner company of the live page at `pagePath` (`/nl/actie`) in `locale`, only when that
 * page is a `landing` page; null for every other page, an unknown path or a draft.
 */
export async function landingPartnerFor(db: DbOrTx, locale: Locale, pagePath: string): Promise<string | null> {
  const prefix = localePath(locale, "");
  let clean = (pagePath.split(/[?#]/)[0] ?? "").toLowerCase();
  if (clean === prefix || clean.startsWith(`${prefix}/`)) clean = clean.slice(prefix.length);
  clean = clean.replace(/^\/+|\/+$/g, "");
  const [row] = await db
    .select({ kind: pages.kind, partnerCompanyId: pages.partnerCompanyId })
    .from(pageRoutes)
    .innerJoin(pages, eq(pages.id, pageRoutes.pageId))
    .where(and(eq(pageRoutes.locale, locale), eq(pageRoutes.path, clean), eq(pages.status, "published")))
    .limit(1);
  return row?.kind === "landing" ? (row.partnerCompanyId ?? null) : null;
}

/** `landingPartnerFor` on the app database, cached with the page tags `setPagePartner` and publishing revalidate. */
async function cachedLandingPartner(locale: Locale, pagePath: string): Promise<string | null> {
  const load = async () => landingPartnerFor(await getAppDb(), locale, pagePath);
  try {
    return await unstable_cache(load, ["site:landingPartner", locale, pagePath], { tags: ["site:pages", "site:routes"] })();
  } catch (error) {
    if (/incrementalCache missing|static generation store missing/i.test(String((error as Error)?.message ?? error))) return load();
    throw error;
  }
}

/** The embed of a page whose partner is looked up first (a failed lookup embeds without a partner). */
async function PartnerFormEmbed({ props }: { props: FormEmbedProps }) {
  let partner: string | null = null;
  try {
    partner = await cachedLandingPartner(props.locale, props.context.pagePath);
  } catch (error) {
    reportBlockError(error, "form_embed", { slug: props.slug, step: "partner" });
  }
  return SafeFormEmbed(partner ? { ...props, context: { ...props.context, partnerCompanyId: partner } } : props);
}

type PartnerAwareData = BlockContext["data"] & { partnerCompanyId?: string | null; pageKind?: string };

/**
 * True when forms' `FormEmbed` is an async server component (the real one is): the partner
 * lookup then adds no extra suspension. A synchronous stand-in (unit tests that render with
 * `renderToStaticMarkup`) is called directly.
 */
const embedIsAsync = (): boolean => (FormEmbed as unknown as { constructor?: { name?: string } }).constructor?.name === "AsyncFunction";

export function FormEmbedBlockView({ block, ctx }: { block: BlockOf<"form_embed">; ctx: BlockContext }) {
  const data = ctx.data as PartnerAwareData;
  const base = formEmbedProps(block.formSlug, ctx.locale, data.pagePath, data.utm);
  // Render data that already knows the page's partner (`partnerCompanyId` with `pageKind`) needs no lookup.
  if ("partnerCompanyId" in data) {
    const partner = data.pageKind === undefined || data.pageKind === "landing" ? data.partnerCompanyId : null;
    return <div data-form={block.formSlug}>{SafeFormEmbed(formEmbedProps(block.formSlug, ctx.locale, data.pagePath, data.utm, partner))}</div>;
  }
  return <div data-form={block.formSlug}>{embedIsAsync() ? <PartnerFormEmbed props={base} /> : SafeFormEmbed(base)}</div>;
}

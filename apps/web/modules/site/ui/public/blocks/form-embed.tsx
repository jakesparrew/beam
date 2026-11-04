/**
 * `form_embed` block: forms' `FormEmbed` server component with the page path, the landing path
 * and the request's UTM parameters (rule 40, blueprint 16). A failure of the forms module hides
 * the block and is reported; the page still renders.
 */
import type { ReactNode } from "react";
import type { FormEmbedProps, UtmParams } from "@beam/core/forms";
import type { Locale } from "@beam/core/i18n";
import { reportError } from "@/lib/logger";
import { FormEmbed } from "@/modules/forms/api";
import type { BlockContext, BlockOf } from "../block-renderer";

/** Renders forms' `FormEmbed`, isolating a throwing or rejecting embed. */
export function SafeFormEmbed(props: FormEmbedProps): ReactNode {
  try {
    const out = (FormEmbed as (p: FormEmbedProps) => unknown)(props);
    if (out && typeof (out as Promise<unknown>).then === "function") {
      return (out as Promise<ReactNode>).catch((error: unknown) => {
        reportError(error, { tags: { module: "site", step: "form_embed" }, extra: { slug: props.slug } });
        return null;
      }) as unknown as ReactNode;
    }
    return out as ReactNode;
  } catch (error) {
    reportError(error, { tags: { module: "site", step: "form_embed" }, extra: { slug: props.slug } });
    return null;
  }
}

export function formEmbedProps(slug: string, locale: Locale, pagePath: string, utm: UtmParams): FormEmbedProps {
  return { slug, locale, context: { pagePath, landingPath: pagePath, ...(Object.keys(utm).length ? { utm } : {}) } };
}

export function FormEmbedBlockView({ block, ctx }: { block: BlockOf<"form_embed">; ctx: BlockContext }) {
  return <div data-form={block.formSlug}>{SafeFormEmbed(formEmbedProps(block.formSlug, ctx.locale, ctx.data.pagePath, ctx.data.utm))}</div>;
}

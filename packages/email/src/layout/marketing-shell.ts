/**
 * The MJML shell of block-backed emails (marketing templates, campaigns, block-backed
 * transactional templates): `<mjml lang="<locale>" dir="ltr">`, title, preheader, BEAM header,
 * the body sections and the legal footer (email spec rules 4, 15b). MJML renders every layout
 * table with `role="presentation"`.
 */
import type { Locale } from "@beam/core/i18n";
import { escapeKeepingTokens } from "../blocks/markdown";
import { BRAND, type Brand } from "./brand";

export type MarketingShellInput = {
  locale: Locale;
  /** MJML `mj-section` elements of the body (`blocksToMjml`). */
  body: string;
  /** The footer HTML fragment (`buildFooter().html`). */
  footerHtml: string;
  brand?: Brand;
  /** The `<title>`; tokens allowed. */
  title?: string;
  /** Hidden preview text; tokens allowed. */
  preheader?: string;
};

function header(brand: Brand): string {
  const content = brand.logoUrl
    ? `<mj-image src="${escapeKeepingTokens(brand.logoUrl)}" alt="${escapeKeepingTokens(brand.name)}" width="140px" align="left" padding="24px 24px 8px" />`
    : `<mj-text padding="24px 24px 8px"><p style="margin:0;color:${brand.color};font-size:20px;font-weight:700;letter-spacing:0.04em">${escapeKeepingTokens(brand.name)}</p></mj-text>`;
  return `<mj-section background-color="${brand.surface}" padding="0"><mj-column>\n${content}\n</mj-column></mj-section>`;
}

export function marketingShell(input: MarketingShellInput): string {
  const brand = input.brand ?? BRAND;
  const title = input.title ? `<mj-title>${escapeKeepingTokens(input.title)}</mj-title>` : "";
  const preview = input.preheader ? `<mj-preview>${escapeKeepingTokens(input.preheader)}</mj-preview>` : "";
  return `<mjml lang="${input.locale}" dir="ltr">
<mj-head>
${title}
${preview}
<mj-attributes>
<mj-all font-family="${brand.font}" />
<mj-text color="${brand.text}" font-size="${brand.bodySize}px" line-height="1.5" />
</mj-attributes>
<mj-style>a { color: ${brand.color}; } p { margin: 0 0 16px; }</mj-style>
</mj-head>
<mj-body background-color="${brand.background}" width="${brand.width}px">
<mj-wrapper padding="24px 0">
${header(brand)}
${input.body}
<mj-section background-color="${brand.surface}" padding="8px 0 24px"><mj-column>
<mj-divider border-color="${brand.border}" border-width="1px" padding="16px 24px" />
<mj-text padding="0 24px" font-size="${brand.footerSize}px" color="${brand.muted}" line-height="18px">${input.footerHtml}</mj-text>
</mj-column></mj-section>
</mj-wrapper>
</mj-body>
</mjml>`;
}

/**
 * The MJML shell of block-backed emails (marketing templates, campaigns, block-backed
 * transactional templates): `<mjml lang="<locale>" dir="ltr">`, title, preheader, BEAM header,
 * the body sections and the legal footer (email spec rules 4, 15b). MJML renders every layout
 * table with `role="presentation"`.
 */
import type { Locale } from "@beam/core/i18n";
import { escapeKeepingTokens } from "../blocks/markdown";
import { BRAND, EMAIL_IMAGES, type Brand } from "./brand";

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
    ? `<mj-image src="${escapeKeepingTokens(brand.logoUrl)}" alt="${escapeKeepingTokens(brand.name)}" width="220px" align="center" padding="30px 24px 26px" />`
    : `<mj-text align="center" padding="30px 24px 26px"><p style="margin:0;color:#ffffff;font-size:22px;font-weight:600;letter-spacing:0.08em">${escapeKeepingTokens(brand.name)}</p></mj-text>`;
  return `<mj-section background-color="${brand.header}" padding="0" border-radius="16px 16px 0 0"><mj-column>
${content}
</mj-column></mj-section>
<mj-section padding="0"><mj-column><mj-image src="${EMAIL_IMAGES.goldLine}" alt="" height="4px" padding="0" /></mj-column></mj-section>`;
}

function footerLogo(): string {
  return `<mj-image src="${EMAIL_IMAGES.logoFooter}" alt="BEAM Vitality Center" width="88px" align="center" padding="28px 24px 14px" />`;
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
<mj-button background-color="${brand.button}" color="${brand.buttonText}" border-radius="15px" font-weight="600" />
<mj-text color="${brand.text}" font-size="${brand.bodySize}px" line-height="1.5" />
</mj-attributes>
<mj-font name="Poppins" href="https://fonts.googleapis.com/css2?family=Lora:wght@600&family=Poppins:wght@400;500;600&display=swap" />
<mj-style>a { color: ${brand.color}; } p { margin: 0 0 16px; }</mj-style>
</mj-head>
<mj-body background-color="${brand.background}" width="${brand.width}px">
<mj-wrapper padding="32px 0 8px">
${header(brand)}
<mj-section background-color="${brand.surface}" padding="20px 0 0"><mj-column></mj-column></mj-section>
${input.body}
<mj-section background-color="${brand.surface}" padding="8px 0 16px" border-radius="0 0 16px 16px"><mj-column></mj-column></mj-section>
</mj-wrapper>
<mj-section padding="0 0 24px"><mj-column>
${footerLogo()}
<mj-text align="center" padding="0 32px" font-size="${brand.footerSize}px" color="${brand.muted}" line-height="18px">${input.footerHtml}</mj-text>
</mj-column></mj-section>
</mj-body>
</mjml>`;
}

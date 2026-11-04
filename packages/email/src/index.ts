/**
 * `@beam/email`: react-email templates, the renderer, the shared layout, the legal footer, the
 * block compiler and the Resend message builder.
 *
 * Wave 0 files written by platform-P3 (`layout.tsx`, `render.ts`, `templates/define.ts`);
 * email-P2 extended them under the same names and added `blocks/`, `layout/` and `resend.ts`.
 * Prefer the subpaths: `@beam/email/render`, `@beam/email/layout`,
 * `@beam/email/templates/define`, `@beam/email/templates/registry`, `@beam/email/blocks`.
 */
export {
  renderEmail,
  resolveCopy,
  extractLinks,
  type RenderedEmail,
  type RenderInput,
  type CodeRenderInput,
  type BlocksRenderInput,
  type CopyOverrides,
  type RenderTemplateOptions,
  type RenderElementOptions,
} from "./render";
export { EmailLayout, EmailHeading, EmailText, EmailButton, EmailFooterContext, BRAND } from "./layout";
export { brandContrastReport, contrastRatio, relativeLuminance, MIN_CONTRAST, MIN_BODY_SIZE, type Brand, type ContrastCheck } from "./layout/brand";
export {
  buildFooter,
  footerProblems,
  formatEnterpriseNumber,
  DEFAULT_FOOTER_SETTINGS,
  FOOTER_COPY,
  CATEGORY_NAMES,
  FooterHtml,
  type BuildFooterInput,
  type FooterCompany,
  type FooterSettings,
  type FooterPurpose,
  type FooterParts,
  type FooterPreferenceUrls,
  type LegalLinks,
} from "./layout/footer";
export { marketingShell, type MarketingShellInput } from "./layout/marketing-shell";
export {
  buildOutgoingEmail,
  sinkSubject,
  LIST_UNSUBSCRIBE_POST,
  type OutgoingEmail,
  type OutgoingMessage,
  type OutgoingAttachment,
  type OutgoingTag,
  type BuildOutgoingOptions,
} from "./resend";
export {
  defineTemplate,
  registryProblems,
  templateFileBasename,
  TEMPLATE_NAME_PATTERN,
  type TemplateDef,
  type CopySlots,
  type MessageKey,
  type TemplateAttachment,
  type TemplateComponentProps,
  type LoadPropsArgs,
  type RegistryEntryRef,
} from "./templates/define";
export * from "./blocks";

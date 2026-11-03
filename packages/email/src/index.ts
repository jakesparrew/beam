/**
 * `@beam/email`: react-email templates, the renderer and the shared layout.
 *
 * Wave 0 files written by platform-P3 (`layout.tsx`, `render.ts`, `templates/define.ts`);
 * email-P2 extends them under the same names and adds `blocks/`. Prefer the subpaths:
 * `@beam/email/render`, `@beam/email/layout`, `@beam/email/templates/define`,
 * `@beam/email/templates/registry`, `@beam/email/blocks`.
 */
export { renderEmail, resolveCopy, type RenderedEmail, type RenderTemplateOptions, type RenderElementOptions } from "./render";
export { EmailLayout, EmailHeading, EmailText, EmailButton, BRAND } from "./layout";
export {
  defineTemplate,
  templateFileBasename,
  TEMPLATE_NAME_PATTERN,
  type TemplateDef,
  type CopySlots,
  type MessageKey,
  type TemplateAttachment,
  type TemplateComponentProps,
  type LoadPropsArgs,
} from "./templates/define";

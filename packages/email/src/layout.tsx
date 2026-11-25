/**
 * The shared transactional email layout (BEAM branding, accessible markup, plain-text friendly).
 * Written by platform-P3 in Wave 0; email-P2 extended it: the legal footer of rule 4 (built by
 * `buildFooter()` and handed in by `renderEmail()` through `EmailFooterContext`), the brand from
 * `layout/brand.ts`, `lang` and `dir` on `<html>` (rule 15b). The Wave 0 exports stay.
 *
 * beam.be look (owner review, November 2026): a black header band with the gold logo, the gold
 * line of the site, an optional hero photo, a white content card on sand, Poppins headings with
 * a short gold rule, gold buttons with black text and 15px corners, sand detail cards, and a
 * footer with the stacked logo and the tagline. Images are hosted (see `EMAIL_IMAGES`); every
 * image has an `alt` text and the layout reads well with images blocked.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ReactNode } from "react";
import { Body, Button, Column, Container, Head, Heading, Html, Img, Link, Preview, Row, Section, Text } from "react-email";
import { t, type Locale } from "@beam/core/i18n";
import { BRAND, EMAIL_IMAGES, type EmailHero } from "./layout/brand";
import type { FooterParts } from "./layout/footer";

export { BRAND, EMAIL_IMAGES };
export type { EmailHero };

/**
 * The footer of the message being rendered. `renderEmail()` provides the legal footer when the
 * caller passes one; `"none"` leaves the footer region empty (the plain-text pass, which
 * appends the footer's own text part instead).
 */
const footerStore = new AsyncLocalStorage<FooterParts | "none" | null>();

/**
 * Not a React context: React server components (where route handlers, server actions and jobs
 * render email) have no `createContext`, so the footer travels in async-local storage for the
 * duration of one `render()` call instead. `EmailFooterContext.run(footer, () => render(el))`.
 */
export const EmailFooterContext = {
  run<T>(value: FooterParts | "none" | null, fn: () => T): T {
    return footerStore.run(value, fn);
  },
};

export type EmailLayoutProps = {
  locale: Locale;
  preheader?: string;
  children: ReactNode;
  /** An extra line above the legal footer (replaces the Wave 0 default line when no legal footer is given). */
  footer?: ReactNode;
  /** A beam.be photo under the header (bookings, webinars, memberships). */
  hero?: EmailHero;
};

const MOBILE_CSS = `
@media only screen and (max-width: 620px) {
  .beam-card { width: 100% !important; border-radius: 0 !important; }
  .beam-pad { padding-left: 24px !important; padding-right: 24px !important; }
  .beam-h1 { font-size: 24px !important; line-height: 32px !important; }
  .beam-btn { display: block !important; text-align: center !important; }
}
.beam-legal-footer p { text-align: center; }
.beam-legal-footer a { color: ${BRAND.muted}; }
`;

export function EmailLayout({ locale, preheader, children, footer, hero }: EmailLayoutProps) {
  const brandName = t(locale, "platform.email.layout.brand");
  return (
    <Html lang={locale} dir="ltr">
      <Head>
        <meta name="color-scheme" content="light" />
        <meta name="supported-color-schemes" content="light" />
        <link href="https://fonts.googleapis.com/css2?family=Lora:wght@600&family=Poppins:wght@400;500;600&display=swap" rel="stylesheet" />
        <style>{MOBILE_CSS}</style>
      </Head>
      {preheader ? <Preview>{preheader}</Preview> : null}
      <Body style={{ backgroundColor: BRAND.background, fontFamily: BRAND.font, margin: 0, padding: "32px 0" }}>
        <Container className="beam-card" style={{ backgroundColor: BRAND.surface, width: "100%", maxWidth: `${BRAND.width}px`, margin: "0 auto", borderRadius: "16px", overflow: "hidden" }}>
          <Section style={{ backgroundColor: BRAND.header, padding: "30px 40px 26px", textAlign: "center" }}>
            <Img src={EMAIL_IMAGES.logoHeader} alt={brandName} width="220" height="43" style={{ display: "block", margin: "0 auto", border: 0 }} />
          </Section>
          <Img src={EMAIL_IMAGES.goldLine} alt="" width="600" height="4" style={{ display: "block", width: "100%", height: "4px", border: 0 }} />
          {hero ? <Img src={EMAIL_IMAGES.hero[hero]} alt="" width="600" height="240" style={{ display: "block", width: "100%", height: "auto", border: 0 }} /> : null}
          <Section className="beam-pad" style={{ padding: "40px 48px 16px" }}>
            {children}
          </Section>
          <Img src={EMAIL_IMAGES.goldLine} alt="" width="600" height="2" style={{ display: "block", width: "100%", height: "2px", border: 0, opacity: 0.6 }} />
        </Container>
        <EmailFooter locale={locale} footer={footer} />
      </Body>
    </Html>
  );
}

function EmailFooter({ locale, footer }: { locale: Locale; footer?: ReactNode }) {
  const legal = footerStore.getStore() ?? null;
  if (legal === "none") return null;
  const lineStyle = { color: BRAND.muted, fontSize: "12px", lineHeight: "18px", margin: "0 0 8px", textAlign: "center" as const };
  return (
    <Container style={{ width: "100%", maxWidth: `${BRAND.width}px`, margin: "0 auto", padding: "28px 32px 8px", textAlign: "center" }}>
      <Img src={EMAIL_IMAGES.logoFooter} alt={t(locale, "platform.email.layout.logo_alt")} width="88" height="86" style={{ display: "block", margin: "0 auto 18px", border: 0 }} />
      {footer ? <Text style={lineStyle}>{footer}</Text> : null}
      {legal ? (
        <div className="beam-legal-footer" style={{ textAlign: "center" }} dangerouslySetInnerHTML={{ __html: legal.html }} />
      ) : footer ? null : (
        <Text style={{ ...lineStyle, margin: 0 }}>{t(locale, "platform.email.layout.footer")}</Text>
      )}
    </Container>
  );
}

/** The page heading: Poppins 500 in black with the short gold rule of beam.be underneath. */
export function EmailHeading({ children }: { children: ReactNode }) {
  return (
    <>
      <Heading as="h1" className="beam-h1" style={{ color: BRAND.text, fontFamily: BRAND.headingFont, fontSize: "28px", lineHeight: "36px", fontWeight: 500, margin: "0 0 14px" }}>
        {children}
      </Heading>
      <div style={{ width: "48px", height: "3px", backgroundColor: BRAND.accent, lineHeight: "3px", fontSize: "1px", margin: "0 0 24px" }}>&nbsp;</div>
    </>
  );
}

export function EmailText({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <Text style={{ color: muted ? BRAND.muted : BRAND.text, fontFamily: BRAND.font, fontSize: muted ? "14px" : "16px", lineHeight: muted ? "22px" : "26px", margin: "0 0 18px" }}>
      {children}
    </Text>
  );
}

/** A call-to-action button (beam.be gold, black text, 15px corners) followed by the plain link, for clients that block buttons. */
export function EmailButton({ href, children, locale, variant = "primary" }: { href: string; children: ReactNode; locale: Locale; variant?: "primary" | "secondary" }) {
  const primary = variant === "primary";
  return (
    <Section style={{ margin: "8px 0 28px" }}>
      <Button
        href={href}
        className="beam-btn"
        style={{
          backgroundColor: primary ? BRAND.button : BRAND.surface,
          color: primary ? BRAND.buttonText : BRAND.text,
          border: primary ? `2px solid ${BRAND.button}` : `2px solid ${BRAND.text}`,
          fontFamily: BRAND.font,
          fontSize: "16px",
          fontWeight: 600,
          padding: "14px 30px",
          borderRadius: "15px",
          textDecoration: "none",
        }}
      >
        {children}
      </Button>
      <Text style={{ color: BRAND.muted, fontFamily: BRAND.font, fontSize: "12px", lineHeight: "18px", margin: "14px 0 0" }}>
        {t(locale, "platform.email.layout.button_fallback")}{" "}
        <Link href={href} style={{ color: BRAND.color, wordBreak: "break-all" }}>
          {href}
        </Link>
      </Text>
    </Section>
  );
}

export type EmailDetail = { label: string; value: ReactNode; strong?: boolean };

/**
 * A summary card (sand panel with a gold edge): the facts of the message (session and time,
 * reference and amount, plan and period) as label/value rows, readable at a glance.
 */
export function EmailDetails({ rows, title }: { rows: readonly (EmailDetail | null | undefined | false)[]; title?: string }) {
  const shown = rows.filter((r): r is EmailDetail => !!r && r.value !== "" && r.value !== null && r.value !== undefined);
  if (!shown.length) return null;
  return (
    <Section style={{ backgroundColor: BRAND.panel, borderLeft: `4px solid ${BRAND.accent}`, borderRadius: "12px", padding: "20px 24px", margin: "4px 0 28px" }}>
      {title ? (
        <Text style={{ color: BRAND.text, fontFamily: BRAND.serifFont, fontSize: "18px", lineHeight: "24px", fontWeight: 600, margin: "0 0 12px" }}>{title}</Text>
      ) : null}
      {shown.map((r, i) => (
        <Row key={i} style={{ marginBottom: i === shown.length - 1 ? 0 : "12px" }}>
          <Column>
            <Text style={{ color: BRAND.muted, fontFamily: BRAND.font, fontSize: "12px", lineHeight: "16px", letterSpacing: "0.06em", textTransform: "uppercase", margin: "0 0 2px" }}>{r.label}</Text>
            <Text style={{ color: BRAND.text, fontFamily: BRAND.font, fontSize: r.strong ? "20px" : "16px", lineHeight: r.strong ? "28px" : "24px", fontWeight: 600, margin: 0 }}>{r.value}</Text>
          </Column>
        </Row>
      ))}
    </Section>
  );
}

/** A short note in a tinted panel (payment at reception, what to bring, a staff message). */
export function EmailNote({ children }: { children: ReactNode }) {
  return (
    <Section style={{ backgroundColor: BRAND.panel, borderRadius: "12px", padding: "14px 20px", margin: "0 0 24px" }}>
      <Text style={{ color: BRAND.text, fontFamily: BRAND.font, fontSize: "14px", lineHeight: "22px", margin: 0 }}>{children}</Text>
    </Section>
  );
}

/** Shorthand for a label from `platform.email.layout.label_*`. */
export function detailLabel(locale: Locale, key: string): string {
  return t(locale, `platform.email.layout.label_${key}`);
}

export type EmailLine = { description: string; quantity?: number; amount?: string };

/** A receipt: one row per line (quantity × description, amount on the right) and the total under a gold rule. */
export function EmailLines({ lines, totalLabel, total, title }: { lines: readonly EmailLine[]; totalLabel?: string; total?: string; title?: string }) {
  const cell = { color: BRAND.text, fontFamily: BRAND.font, fontSize: "15px", lineHeight: "22px", padding: "10px 0", borderBottom: `1px solid ${BRAND.border}`, verticalAlign: "top" as const };
  return (
    <Section style={{ backgroundColor: BRAND.panel, borderRadius: "12px", padding: "18px 24px 14px", margin: "4px 0 28px" }}>
      {title ? (
        <Text style={{ color: BRAND.text, fontFamily: BRAND.serifFont, fontSize: "18px", lineHeight: "24px", fontWeight: 600, margin: "0 0 6px" }}>{title}</Text>
      ) : null}
      <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ borderCollapse: "collapse" }}>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td style={cell}>{l.quantity && l.quantity > 1 ? `${l.quantity} × ` : ""}{l.description}</td>
              <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap", paddingLeft: "16px" }}>{l.amount ?? (l.quantity ? `× ${l.quantity}` : "")}</td>
            </tr>
          ))}
          {total ? (
            <tr>
              <td style={{ ...cell, borderBottom: 0, borderTop: `2px solid ${BRAND.accent}`, fontWeight: 600, paddingTop: "12px" }}>{totalLabel}</td>
              <td style={{ ...cell, borderBottom: 0, borderTop: `2px solid ${BRAND.accent}`, fontWeight: 700, fontSize: "18px", textAlign: "right", whiteSpace: "nowrap", paddingTop: "12px" }}>{total}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </Section>
  );
}

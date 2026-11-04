/**
 * The shared transactional email layout (BEAM branding, accessible markup, plain-text friendly).
 * Written by platform-P3 in Wave 0; email-P2 extended it: the legal footer of rule 4 (built by
 * `buildFooter()` and handed in by `renderEmail()` through `EmailFooterContext`), the brand from
 * `layout/brand.ts`, `lang` and `dir` on `<html>` (rule 15b). The Wave 0 exports stay.
 */
import { createContext, useContext, type ReactNode } from "react";
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from "react-email";
import { t, type Locale } from "@beam/core/i18n";
import { BRAND } from "./layout/brand";
import type { FooterParts } from "./layout/footer";

export { BRAND };

/**
 * The footer of the message being rendered. `renderEmail()` provides the legal footer when the
 * caller passes one; `"none"` leaves the footer region empty (the plain-text pass, which
 * appends the footer's own text part instead).
 */
export const EmailFooterContext = createContext<FooterParts | "none" | null>(null);

export type EmailLayoutProps = {
  locale: Locale;
  preheader?: string;
  children: ReactNode;
  /** An extra line above the legal footer (replaces the Wave 0 default line when no legal footer is given). */
  footer?: ReactNode;
};

export function EmailLayout({ locale, preheader, children, footer }: EmailLayoutProps) {
  return (
    <Html lang={locale} dir="ltr">
      <Head>
        <meta name="color-scheme" content="light" />
      </Head>
      {preheader ? <Preview>{preheader}</Preview> : null}
      <Body style={{ backgroundColor: BRAND.background, fontFamily: BRAND.font, margin: 0, padding: "24px 0" }}>
        <Container style={{ backgroundColor: BRAND.surface, maxWidth: "560px", margin: "0 auto", padding: "32px", borderRadius: "8px" }}>
          <Section>
            <Text style={{ color: BRAND.color, fontSize: "20px", fontWeight: 700, letterSpacing: "0.04em", margin: "0 0 24px" }}>
              {t(locale, "platform.email.layout.brand")}
            </Text>
          </Section>
          <Section>{children}</Section>
          <EmailFooter locale={locale} footer={footer} />
        </Container>
      </Body>
    </Html>
  );
}

function EmailFooter({ locale, footer }: { locale: Locale; footer?: ReactNode }) {
  const legal = useContext(EmailFooterContext);
  if (legal === "none") return null;
  const lineStyle = { color: BRAND.muted, fontSize: "12px", lineHeight: "18px", margin: "0 0 8px" };
  return (
    <>
      <Hr style={{ borderColor: BRAND.border, margin: "32px 0 16px" }} />
      <Section>
        {footer ? <Text style={lineStyle}>{footer}</Text> : null}
        {legal ? (
          <div className="beam-legal-footer" dangerouslySetInnerHTML={{ __html: legal.html }} />
        ) : footer ? null : (
          <Text style={{ ...lineStyle, margin: 0 }}>{t(locale, "platform.email.layout.footer")}</Text>
        )}
      </Section>
    </>
  );
}

export function EmailHeading({ children }: { children: ReactNode }) {
  return (
    <Heading as="h1" style={{ color: BRAND.text, fontSize: "22px", lineHeight: "30px", margin: "0 0 16px" }}>
      {children}
    </Heading>
  );
}

export function EmailText({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text style={{ color: muted ? BRAND.muted : BRAND.text, fontSize: "15px", lineHeight: "24px", margin: "0 0 16px" }}>{children}</Text>;
}

/** A call-to-action button followed by the plain link, for clients that block buttons. */
export function EmailButton({ href, children, locale }: { href: string; children: ReactNode; locale: Locale }) {
  return (
    <Section style={{ margin: "8px 0 24px" }}>
      <Button
        href={href}
        style={{ backgroundColor: BRAND.color, color: BRAND.buttonText, fontSize: "15px", fontWeight: 600, padding: "12px 24px", borderRadius: "6px", textDecoration: "none" }}
      >
        {children}
      </Button>
      <Text style={{ color: BRAND.muted, fontSize: "12px", lineHeight: "18px", margin: "16px 0 0" }}>
        {t(locale, "platform.email.layout.button_fallback")}{" "}
        <Link href={href} style={{ color: BRAND.color, wordBreak: "break-all" }}>
          {href}
        </Link>
      </Text>
    </Section>
  );
}

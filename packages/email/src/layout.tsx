/**
 * The shared transactional email layout (BEAM branding, accessible markup, plain-text friendly).
 * Written by platform-P3 in Wave 0; email-P2 extends it (footer settings, legal block) under
 * the same file name and keeps these exports.
 */
import type { ReactNode } from "react";
import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from "react-email";
import { t, type Locale } from "@beam/core/i18n";

export const BRAND = {
  color: "#1f3a2e",
  accent: "#c8a24a",
  text: "#1c1c1c",
  muted: "#5c5c5c",
  background: "#f4f2ee",
  font: "Helvetica, Arial, sans-serif",
} as const;

export type EmailLayoutProps = {
  locale: Locale;
  preheader?: string;
  children: ReactNode;
  /** Replaces the default transactional footer line. */
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
        <Container style={{ backgroundColor: "#ffffff", maxWidth: "560px", margin: "0 auto", padding: "32px", borderRadius: "8px" }}>
          <Section>
            <Text style={{ color: BRAND.color, fontSize: "20px", fontWeight: 700, letterSpacing: "0.04em", margin: "0 0 24px" }}>
              {t(locale, "platform.email.layout.brand")}
            </Text>
          </Section>
          <Section>{children}</Section>
          <Hr style={{ borderColor: "#e5e1d8", margin: "32px 0 16px" }} />
          <Section>
            <Text style={{ color: BRAND.muted, fontSize: "12px", lineHeight: "18px", margin: 0 }}>
              {footer ?? t(locale, "platform.email.layout.footer")}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
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
        style={{ backgroundColor: BRAND.color, color: "#ffffff", fontSize: "15px", fontWeight: 600, padding: "12px 24px", borderRadius: "6px", textDecoration: "none" }}
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

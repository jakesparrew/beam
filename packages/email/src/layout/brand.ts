/**
 * BEAM email branding (email spec rule 15b): colours, font and sizes shared by the react-email
 * layout (`layout.tsx`) and the MJML marketing shell (`marketing-shell.ts`).
 *
 * Text and button colours must reach a contrast ratio of at least 4.5:1 against the surface
 * they sit on; `brandContrastReport()` checks every pair once and `a11y.test.ts` asserts it.
 * The accent colour is decorative only (rules, borders) and never carries text.
 */

export type Brand = {
  /** Display name in the header. */
  name: string;
  /** Primary colour: headings accent, links, primary button background. */
  color: string;
  /** Decorative accent (dividers, borders); never used for text. */
  accent: string;
  /** Body text colour. */
  text: string;
  /** Secondary text (footer, captions). */
  muted: string;
  /** Page background behind the content card. */
  background: string;
  /** Content card background. */
  surface: string;
  /** Text colour on a primary button. */
  buttonText: string;
  /** Border colour of dividers and secondary buttons. */
  border: string;
  font: string;
  /** Body text size in px (at least 14). */
  bodySize: number;
  /** Footer text size in px. */
  footerSize: number;
  /** Content width in px. */
  width: number;
  /** Absolute logo URL, or null to show the name as text. */
  logoUrl: string | null;
  /** Primary button background (beam.be gold); `buttonText` sits on it. */
  button: string;
  /** Background of the header band behind the logo. */
  header: string;
  /** Heading font stack (beam.be: Poppins 500). */
  headingFont: string;
  /** Serif stack for card titles (beam.be: Lora 600). */
  serifFont: string;
  /** Tinted panel behind detail cards and notes. */
  panel: string;
};

/**
 * Where email images live: the public `brand/email/` folder of the web app. Mail clients fetch
 * them from the internet, so this must be a public https origin (never localhost). Set
 * `EMAIL_ASSET_BASE_URL` to https://beam.be at go-live.
 */
export const EMAIL_ASSET_BASE_URL = (process.env.EMAIL_ASSET_BASE_URL || "https://beam-web-ruddy.vercel.app").replace(/\/+$/, "");

/** The absolute URL of a file in `apps/web/public/brand/email/`. */
export function emailAsset(file: string): string {
  return `${EMAIL_ASSET_BASE_URL}/brand/email/${file}`;
}

/** The images of the layout and the hero photos (beam.be's own pictures, 1200 x 480). */
export const EMAIL_IMAGES = {
  logoHeader: emailAsset("logo-header.png"),
  logoFooter: emailAsset("logo-footer-dark.png"),
  goldLine: emailAsset("gold-line.png"),
  hero: {
    space: emailAsset("hero-space.jpg"),
    night: emailAsset("hero-night.jpg"),
    event: emailAsset("hero-event.jpg"),
    welcome: emailAsset("hero-welcome.jpg"),
  },
} as const;

export type EmailHero = keyof typeof EMAIL_IMAGES.hero;

/** beam.be's look: black text, gold accents and buttons, sand and cream surfaces, Poppins. */
export const BRAND = {
  name: "BEAM",
  color: "#8a5a14",
  accent: "#d1a64a",
  text: "#111111",
  muted: "#5c5c5c",
  background: "#f4ead3",
  surface: "#ffffff",
  buttonText: "#000000",
  border: "#eadfc4",
  font: "Poppins, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  bodySize: 16,
  footerSize: 12,
  width: 600,
  logoUrl: EMAIL_IMAGES.logoHeader,
  button: "#d1a64a",
  header: "#000000",
  headingFont: "Poppins, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  serifFont: "Lora, Georgia, 'Times New Roman', serif",
  panel: "#fbf6ea",
} as const satisfies Brand;

/** The minimum contrast ratio for text (WCAG 2.1 AA, normal text). */
export const MIN_CONTRAST = 4.5;
/** The minimum body text size in px (rule 15b). */
export const MIN_BODY_SIZE = 14;

function channel(hex: string, i: number): number {
  const v = parseInt(hex.slice(i, i + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function normaliseHex(color: string): string {
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  throw new Error(`not a hex colour: ${color}`);
}

/** WCAG relative luminance of a `#rgb` or `#rrggbb` colour. */
export function relativeLuminance(color: string): number {
  const hex = normaliseHex(color);
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG contrast ratio of two colours, from 1 to 21. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

export type ContrastCheck = { pair: string; foreground: string; background: string; ratio: number; ok: boolean };

/** Every text-on-surface pair the layouts use, with its ratio. */
export function brandContrastReport(brand: Brand = BRAND): ContrastCheck[] {
  const pairs: [string, string, string][] = [
    ["text on surface", brand.text, brand.surface],
    ["muted on surface", brand.muted, brand.surface],
    ["muted on background", brand.muted, brand.background],
    ["link on surface", brand.color, brand.surface],
    ["primary button", brand.buttonText, brand.button],
    ["text on panel", brand.text, brand.panel],
    ["muted on panel", brand.muted, brand.panel],
    ["secondary button", brand.color, brand.surface],
  ];
  return pairs.map(([pair, foreground, background]) => {
    const ratio = contrastRatio(foreground, background);
    return { pair, foreground, background, ratio, ok: ratio >= MIN_CONTRAST };
  });
}

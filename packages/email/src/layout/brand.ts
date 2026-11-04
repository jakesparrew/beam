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
};

export const BRAND = {
  name: "BEAM",
  color: "#1f3a2e",
  accent: "#c8a24a",
  text: "#1c1c1c",
  muted: "#5c5c5c",
  background: "#f4f2ee",
  surface: "#ffffff",
  buttonText: "#ffffff",
  border: "#e5e1d8",
  font: "Helvetica, Arial, sans-serif",
  bodySize: 16,
  footerSize: 12,
  width: 600,
  logoUrl: null,
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
    ["primary button", brand.buttonText, brand.color],
    ["secondary button", brand.color, brand.surface],
  ];
  return pairs.map(([pair, foreground, background]) => {
    const ratio = contrastRatio(foreground, background);
    return { pair, foreground, background, ratio, ok: ratio >= MIN_CONTRAST };
  });
}

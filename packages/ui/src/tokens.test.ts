// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * PL-90: every foreground/background token pair used for text keeps a WCAG 2.1
 * contrast ratio of at least 4.5:1, in the light and the dark theme. The colours
 * come from `@beam/config/tailwind-theme.css` plus the overrides in `tokens.css`
 * (later declarations win, exactly as in the browser).
 */

const require = createRequire(import.meta.url);
const themeCss = readFileSync(
  require.resolve("@beam/config/tailwind-theme.css"),
  "utf8",
);
const tokensCss = readFileSync(
  fileURLToPath(new URL("./tokens.css", import.meta.url)),
  "utf8",
);

type Theme = "light" | "dark";

/** Collects `--name: value;` declarations of the `:root` and `.dark` blocks. */
function collect(
  css: string,
  into: Record<Theme, Record<string, string>>,
): void {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blockRe = /(^|\n)\s*(:root|\.dark)\s*\{([^}]*)\}/g;
  for (const match of stripped.matchAll(blockRe)) {
    const theme: Theme = match[2] === ":root" ? "light" : "dark";
    for (const decl of (match[3] ?? "").matchAll(
      /--([a-z0-9-]+)\s*:\s*([^;]+);/g,
    )) {
      into[theme][decl[1]!] = decl[2]!.trim();
    }
  }
}

const tokens: Record<Theme, Record<string, string>> = { light: {}, dark: {} };
collect(themeCss, tokens);
collect(tokensCss, tokens);

function resolve(theme: Theme, name: string): string {
  const value = tokens[theme][name] ?? tokens.light[name];
  if (!value) throw new Error(`token --${name} is not defined`);
  return value;
}

/** OKLCH (Björn Ottosson's matrices) to linear sRGB, clipped to the gamut. */
function oklchToLinearSrgb(value: string): [number, number, number] {
  const m =
    /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+%?))?\s*\)$/.exec(
      value,
    );
  if (!m) throw new Error(`not an oklch() colour: ${value}`);
  if (m[5] !== undefined)
    throw new Error(`text colours must be opaque: ${value}`);
  const L = Number(m[1]) / (m[2] === "%" ? 100 : 1);
  const C = Number(m[3]);
  const h = (Number(m[4]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clip(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s),
    clip(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s),
    clip(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s),
  ];
}

/**
 * The browser paints (and axe measures) 8-bit sRGB, so each channel is encoded, rounded to
 * 0..255 and decoded again; a pair at 4.501:1 unrounded can land at 4.496:1 on screen.
 */
function quantize(x: number): number {
  const encoded = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  const v = Math.round(encoded * 255) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(value: string): number {
  const [r, g, b] = oklchToLinearSrgb(value).map(quantize) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** [text token, background token]: every pair the components render text with. */
const TEXT_PAIRS: [string, string][] = [
  ["foreground", "background"],
  ["foreground", "muted"],
  ["foreground", "accent"],
  ["foreground", "secondary"],
  ["card-foreground", "card"],
  ["popover-foreground", "popover"],
  ["primary-foreground", "primary"],
  ["primary", "background"],
  ["primary", "card"],
  ["secondary-foreground", "secondary"],
  ["muted-foreground", "muted"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "popover"],
  ["accent-foreground", "accent"],
  ["destructive-foreground", "destructive"],
  ["destructive", "background"],
  ["destructive", "card"],
  ["sidebar-foreground", "sidebar"],
  ["muted-foreground", "sidebar"],
  ["sidebar-primary-foreground", "sidebar-primary"],
  ["sidebar-accent-foreground", "sidebar-accent"],
];

describe("design tokens (PL-90)", () => {
  it("parses both themes", () => {
    expect(Object.keys(tokens.light).length).toBeGreaterThan(20);
    expect(Object.keys(tokens.dark).length).toBeGreaterThan(20);
  });

  it("computes WCAG contrast correctly", () => {
    expect(contrast("oklch(0 0 0)", "oklch(1 0 0)")).toBeCloseTo(21, 1);
    expect(contrast("oklch(1 0 0)", "oklch(1 0 0)")).toBeCloseTo(1, 5);
  });

  for (const theme of ["light", "dark"] as const) {
    for (const [fg, bg] of TEXT_PAIRS) {
      it(`${theme}: --${fg} on --${bg} is at least 4.5:1`, () => {
        const ratio = contrast(resolve(theme, fg), resolve(theme, bg));
        expect(
          ratio,
          `${theme} ${fg}/${bg} = ${ratio.toFixed(2)}`,
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("tokens.css imports the shared theme and tw-animate-css and respects reduced motion", () => {
    expect(tokensCss).toContain('@import "tw-animate-css"');
    expect(tokensCss).toContain('@import "@beam/config/tailwind-theme.css"');
    expect(tokensCss).toMatch(/prefers-reduced-motion:\s*reduce/);
  });
});

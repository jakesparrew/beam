import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** WCAG 2.1 level AA rule tags (PL-90). */
export const A11Y_TAGS = ["wcag2a", "wcag2aa", "wcag21aa"] as const;

/** Impacts that fail a spec (PL-90): `minor` and `moderate` are reported but tolerated. */
const BLOCKING = new Set(["serious", "critical"]);

/**
 * Runs axe on the current page and fails on any `serious` or `critical` violation.
 * Every Playwright spec calls it on each page it visits (PL-90).
 */
export async function expectAccessible(page: Page, options: { exclude?: string[] } = {}): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([...A11Y_TAGS]);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const blocking = results.violations
    .filter((v) => BLOCKING.has(v.impact ?? ""))
    .map((v) => `${v.impact}: ${v.id} (${v.help}) on ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
  expect(blocking, `accessibility violations on ${page.url()}`).toEqual([]);
}

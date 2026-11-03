/**
 * i18n parity on the real catalogues (PL-62, platform-P7): runs the `pnpm i18n:check` checker
 * over `packages/core/src/i18n/messages` and expects no problem (missing, extra or empty keys,
 * wrong prefixes, invalid ICU) in `en`, `nl-BE` and `fr-BE`.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_IDS } from "@beam/config";
import { checkCatalogues, DEFAULT_DIR, formatProblem } from "../../../packages/core/scripts/i18n-check";

describe("i18n parity", () => {
  it("every catalogue of every module exists in all three locales", () => {
    for (const locale of ["en", "nl-BE", "fr-BE"]) {
      for (const m of MODULE_IDS) expect(fs.existsSync(path.join(DEFAULT_DIR, locale, `${m}.json`)), `${locale}/${m}.json`).toBe(true);
    }
  });

  it("the real catalogues have no problems", () => {
    expect(checkCatalogues(DEFAULT_DIR).map(formatProblem)).toEqual([]);
  });

  it("every declared permission has a label in its module's catalogue", async () => {
    const { PERMISSION_MODULE } = await import("@/registry/permissions.generated");
    const en = (m: string) => JSON.parse(fs.readFileSync(path.join(DEFAULT_DIR, "en", `${m}.json`), "utf8")) as Record<string, { permissions?: Record<string, string> }>;
    for (const [permission, module] of Object.entries(PERMISSION_MODULE)) {
      expect(en(module)[module]?.permissions?.[permission.replace(".", "_")], `${module}.permissions.${permission}`).toBeTruthy();
    }
  });
});

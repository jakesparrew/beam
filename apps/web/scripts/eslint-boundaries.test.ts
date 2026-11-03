import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Lints fixture code through the ESLint Node API with the boundary config objects of the
// real repository config (PL-51, PL-82). Fixtures are linted under a virtual path inside
// the scope under test; `ignore: false` because the config ignores scripts/__fixtures__
// (DR-18). The type-aware part of the config is left out because a virtual path belongs
// to no tsconfig project; the boundary rules are syntactic.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const fixture = (name: string) => fs.readFileSync(path.join(here, "__fixtures__/eslint", name), "utf8");

type FlatConfig = { name?: string; files?: string[]; rules?: Record<string, unknown> };
// A non-literal specifier keeps TypeScript from asking for a declaration file of the JS config.
const configModule = "@beam/config/eslint";
const shared = (await import(configModule)) as { default: FlatConfig[]; boundaries: FlatConfig[] };

const eslint = new ESLint({
  cwd: root,
  ignore: false,
  overrideConfigFile: true,
  // The typescript-eslint parser (syntax only) plus the boundary objects.
  overrideConfig: [
    ...shared.default.filter((c) => c.name === "typescript-eslint/base"),
    ...shared.boundaries,
  ] as ESLint.Options["overrideConfig"],
});

async function restrictedImports(code: string, virtualPath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, virtualPath) });
  if (!result) throw new Error("no lint result");
  const fatal = result.messages.filter((m) => m.fatal);
  if (fatal.length) throw new Error(fatal.map((m) => m.message).join("\n"));
  return result.messages.filter((m) => m.ruleId?.endsWith("no-restricted-imports")).map((m) => m.message);
}

describe("eslint boundaries", () => {
  it("are part of the repository config", () => {
    const names = new Set(shared.default.map((c) => c.name));
    for (const b of shared.boundaries) expect(names.has(b.name), b.name).toBe(true);
  });

  it("forbids modules/crm importing modules/booking/queries (PL-82)", async () => {
    const errors = await restrictedImports(fixture("crm-imports-booking.ts"), "apps/web/modules/crm/x.ts");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("modules/<m>/api");
  });

  it("forbids the alias form @/modules/booking/queries too", async () => {
    const code = 'import { listSessions } from "@/modules/booking/queries";\nexport const x = listSessions;\n';
    expect(await restrictedImports(code, "apps/web/modules/crm/ui/list.ts")).toHaveLength(1);
  });

  it("allows another module's api.ts and the module's own files", async () => {
    expect(await restrictedImports(fixture("crm-imports-booking-api.ts"), "apps/web/modules/crm/x.ts")).toEqual([]);
    const own = 'import { x } from "../crm/queries";\nimport { y } from "./queries";\nexport const z = [x, y];\n';
    expect(await restrictedImports(own, "apps/web/modules/crm/sub.ts")).toEqual([]);
  });

  it("forbids @anthropic-ai/sdk outside packages/integrations/src/anthropic/ (PL-51)", async () => {
    const code = fixture("anthropic-outside.ts");
    for (const where of ["apps/web/modules/site/ai.ts", "apps/web/lib/ai.ts", "packages/integrations/src/slack/client.ts"]) {
      const errors = await restrictedImports(code, where);
      expect(errors, where).toHaveLength(1);
      expect(errors[0]).toContain("PL-51");
    }
    expect(await restrictedImports(code, "packages/integrations/src/anthropic/client.ts")).toEqual([]);
  });

  it("applies the package import table of architecture section 1", async () => {
    const value = 'import { getDb } from "@beam/db";\nexport const x = getDb;\n';
    const typeOnly = 'import type { Db } from "@beam/db";\nexport type X = Db;\n';
    expect(await restrictedImports(value, "packages/core/src/booking/x.ts")).toHaveLength(1);
    expect(await restrictedImports(typeOnly, "packages/core/src/booking/x.ts")).toEqual([]);
    expect(await restrictedImports('import { z } from "react";\nexport const x = z;\n', "packages/core/src/x.ts")).toHaveLength(1);
    expect(await restrictedImports('import { t } from "@beam/core/i18n";\nexport const x = t;\n', "packages/ui/src/x.ts")).toHaveLength(1);
    expect(await restrictedImports('import { a } from "@beam/email";\nexport const x = a;\n', "packages/db/src/x.ts")).toHaveLength(1);
    expect(await restrictedImports('import { a } from "@beam/db";\nexport const x = a;\n', "packages/email/src/x.ts")).toHaveLength(1);
    expect(await restrictedImports('import { a } from "@beam/email";\nexport const x = a;\n', "packages/integrations/src/x.ts")).toHaveLength(1);
    expect(await restrictedImports('import { a } from "@beam/core";\nexport const x = a;\n', "packages/config/src/x.ts")).toHaveLength(1);
    expect(await restrictedImports('import { a } from "@beam/db";\nexport const x = a;\n', "apps/web/lib/x.ts")).toEqual([]);
  });
});
